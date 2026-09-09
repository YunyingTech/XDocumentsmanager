use std::fs::{File, OpenOptions};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use serde_json::{json, Value};

use crate::models::{SearchBackendStatus, SearchFilters};

use super::engine::{for_each_document, SearchDocument, SearchHit};

const INDEX_NAME: &str = "xdocuments-v1";

#[derive(Clone)]
struct ElasticConfig {
    distribution_dir: PathBuf,
    data_dir: PathBuf,
    logs_dir: PathBuf,
}

pub struct ElasticRuntime {
    config: RwLock<Option<ElasticConfig>>,
    endpoint: RwLock<Option<String>>,
    version: RwLock<Option<String>>,
    error: RwLock<Option<String>>,
    process: Mutex<Option<Child>>,
    #[cfg(windows)]
    job_handle: Mutex<Option<isize>>,
    client: Client,
}

impl ElasticRuntime {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            config: RwLock::new(None),
            endpoint: RwLock::new(None),
            version: RwLock::new(None),
            error: RwLock::new(None),
            process: Mutex::new(None),
            #[cfg(windows)]
            job_handle: Mutex::new(None),
            client,
        })
    }

    pub fn configure(&self, distribution_dir: PathBuf, data_dir: PathBuf, logs_dir: PathBuf) {
        *self.config.write().expect("elastic config lock poisoned") = Some(ElasticConfig {
            distribution_dir,
            data_dir,
            logs_dir,
        });
    }

    pub fn is_ready(&self) -> bool {
        self.endpoint
            .read()
            .map(|value| value.is_some())
            .unwrap_or(false)
    }

    pub fn start(&self) -> Result<(), String> {
        let result = self.start_inner();
        if let Err(ref message) = result {
            if let Ok(mut error) = self.error.write() {
                *error = Some(message.clone());
            }
        }
        result
    }

    fn start_inner(&self) -> Result<(), String> {
        let config = self
            .config
            .read()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "Bundled Elasticsearch runtime is not configured".to_string())?;
        std::fs::create_dir_all(&config.data_dir).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&config.logs_dir).map_err(|e| e.to_string())?;
        let distribution_dir = resolve_distribution_dir(&config.distribution_dir)?;
        let launcher = elasticsearch_launcher(&distribution_dir);
        let elastic_root = config
            .data_dir
            .parent()
            .ok_or_else(|| "Elasticsearch data directory has no parent".to_string())?;
        let runtime_config_dir = elastic_root.join("config");
        prepare_runtime_config(
            &distribution_dir.join("config"),
            &runtime_config_dir,
            &config.data_dir,
            &config.logs_dir,
        )?;
        let http_port = reserve_port()?;
        let transport_port = reserve_port()?;
        let endpoint = format!("http://127.0.0.1:{}", http_port);

        let stdout = append_log(&config.logs_dir.join("elasticsearch-stdout.log"))?;
        let stderr = append_log(&config.logs_dir.join("elasticsearch-stderr.log"))?;
        let mut command = Command::new(&launcher);
        command
            .current_dir(&distribution_dir)
            .env("ES_PATH_CONF", &runtime_config_dir)
            .env("ES_JAVA_OPTS", "-Xms512m -Xmx512m -Djava.awt.headless=true")
            .args([
                "-Ecluster.name=xdocuments",
                "-Enode.name=xdocuments-local",
                "-Ediscovery.type=single-node",
                "-Expack.security.enabled=false",
                "-Expack.security.enrollment.enabled=false",
                "-Ehttp.host=127.0.0.1",
                &format!("-Ehttp.port={}", http_port),
                "-Etransport.host=127.0.0.1",
                &format!("-Etransport.port={}", transport_port),
                &format!("-Epath.data={}", config.data_dir.display()),
                &format!("-Epath.logs={}", config.logs_dir.display()),
                "-Eingest.geoip.downloader.enabled=false",
                "-Expack.ml.enabled=false",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start bundled Elasticsearch: {}", e))?;
        #[cfg(windows)]
        {
            match create_kill_on_close_job(&child) {
                Ok(handle) => *self.job_handle.lock().map_err(|e| e.to_string())? = Some(handle),
                Err(error) => {
                    let _ = child.kill();
                    return Err(error);
                }
            }
        }
        *self.process.lock().map_err(|e| e.to_string())? = Some(child);

        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            if let Some(status) = self
                .process
                .lock()
                .map_err(|e| e.to_string())?
                .as_mut()
                .and_then(|child| child.try_wait().ok())
                .flatten()
            {
                return self.fail(format!(
                    "Elasticsearch exited during startup with {}",
                    status
                ));
            }
            if let Ok(response) = self.client.get(&endpoint).send() {
                if response.status().is_success() {
                    let body: Value = response.json().map_err(|e| e.to_string())?;
                    let version = body
                        .pointer("/version/number")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string();
                    self.ensure_index(&endpoint)?;
                    let endpoint_for_log = endpoint.clone();
                    *self.endpoint.write().map_err(|e| e.to_string())? = Some(endpoint);
                    *self.version.write().map_err(|e| e.to_string())? = Some(version);
                    *self.error.write().map_err(|e| e.to_string())? = None;
                    log::info!(
                        "Elasticsearch {} is ready at {}",
                        self.version
                            .read()
                            .ok()
                            .and_then(|value| value.clone())
                            .unwrap_or_default(),
                        endpoint_for_log
                    );
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                return self
                    .fail("Elasticsearch did not become ready within 180 seconds".to_string());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    pub fn apply_changes(
        &self,
        documents: &[SearchDocument],
        deleted_file_ids: &[i64],
    ) -> Result<bool, String> {
        let Some(endpoint) = self.endpoint()? else {
            return Ok(false);
        };
        if let Err(error) = self.apply_changes_inner(&endpoint, documents, deleted_file_ids) {
            return self.disable(format!(
                "Elasticsearch incremental update failed; embedded search is active: {error}"
            ));
        }
        Ok(true)
    }

    fn apply_changes_inner(
        &self,
        endpoint: &str,
        documents: &[SearchDocument],
        deleted_file_ids: &[i64],
    ) -> Result<(), String> {
        let mut body = String::new();
        for file_id in deleted_file_ids {
            append_bulk_line(
                &mut body,
                &json!({ "delete": { "_index": INDEX_NAME, "_id": file_id } }),
            )?;
        }
        for document in documents {
            append_bulk_line(
                &mut body,
                &json!({ "index": { "_index": INDEX_NAME, "_id": document.file_id } }),
            )?;
            append_bulk_line(&mut body, document)?;
        }
        if !body.is_empty() {
            self.send_bulk(endpoint, body, true)?;
        }
        Ok(())
    }

    pub fn delete_folder(&self, folder_id: i64) -> Result<bool, String> {
        let Some(endpoint) = self.endpoint()? else {
            return Ok(false);
        };
        if let Err(error) = self.delete_folder_inner(&endpoint, folder_id) {
            return self.disable(format!(
                "Elasticsearch folder deletion failed; embedded search is active: {error}"
            ));
        }
        Ok(true)
    }

    fn delete_folder_inner(&self, endpoint: &str, folder_id: i64) -> Result<(), String> {
        let response = self
            .client
            .post(format!(
                "{}/{}/_delete_by_query?refresh=true",
                endpoint, INDEX_NAME
            ))
            .json(&json!({ "query": { "term": { "folder_id": folder_id } } }))
            .send()
            .map_err(|e| e.to_string())?;
        ensure_success(response, "delete Elasticsearch folder documents")?;
        Ok(())
    }

    pub fn rebuild(&self, conn: &rusqlite::Connection) -> Result<bool, String> {
        let Some(endpoint) = self.endpoint()? else {
            return Ok(false);
        };
        if let Err(error) = self.rebuild_inner(conn, &endpoint) {
            return self.disable(format!(
                "Elasticsearch rebuild failed; embedded search is active: {error}"
            ));
        }
        Ok(true)
    }

    pub fn document_count(&self) -> Result<Option<u64>, String> {
        let Some(endpoint) = self.endpoint()? else {
            return Ok(None);
        };
        self.ensure_index(&endpoint)?;
        let response = self
            .client
            .get(format!("{}/{}/_count", endpoint, INDEX_NAME))
            .send()
            .map_err(|e| e.to_string())?;
        let value = ensure_success_json(response, "count Elasticsearch documents")?;
        value
            .get("count")
            .and_then(Value::as_u64)
            .map(Some)
            .ok_or_else(|| "Elasticsearch count response has no count".to_string())
    }

    fn rebuild_inner(&self, conn: &rusqlite::Connection, endpoint: &str) -> Result<(), String> {
        let delete = self
            .client
            .delete(format!("{}/{}", endpoint, INDEX_NAME))
            .send()
            .map_err(|e| e.to_string())?;
        if delete.status().as_u16() != 404 {
            ensure_success(delete, "replace Elasticsearch index")?;
        }
        self.ensure_index(endpoint)?;

        let mut body = String::new();
        for_each_document(conn, |document| {
            let action = serde_json::to_string(
                &json!({ "index": { "_index": INDEX_NAME, "_id": document.file_id } }),
            )
            .map_err(|e| e.to_string())?;
            let source = serde_json::to_string(&document).map_err(|e| e.to_string())?;
            if !body.is_empty() && body.len() + action.len() + source.len() + 2 > 8 * 1024 * 1024 {
                self.send_bulk(endpoint, std::mem::take(&mut body), false)?;
            }
            body.push_str(&action);
            body.push('\n');
            body.push_str(&source);
            body.push('\n');
            Ok(())
        })?;
        if !body.is_empty() {
            self.send_bulk(endpoint, body, false)?;
        }
        let refresh = self
            .client
            .post(format!("{}/{}/_refresh", endpoint, INDEX_NAME))
            .send()
            .map_err(|e| e.to_string())?;
        ensure_success(refresh, "refresh Elasticsearch index")?;
        Ok(())
    }

    pub fn search(
        &self,
        query: &str,
        filters: Option<&SearchFilters>,
        offset: usize,
        limit: usize,
    ) -> Result<Option<super::engine::SearchPage>, String> {
        let Some(endpoint) = self.endpoint()? else {
            return Ok(None);
        };
        let mut filter = Vec::new();
        if let Some(filters) = filters {
            if let Some(folder_id) = filters.folder_id {
                filter.push(json!({ "term": { "folder_id": folder_id } }));
            }
            if let Some(ref extension) = filters.file_extension {
                filter.push(json!({ "term": { "extension": extension.to_lowercase() } }));
            }
            if filters.size_min.is_some() || filters.size_max.is_some() {
                let mut range = serde_json::Map::new();
                if let Some(value) = filters.size_min {
                    range.insert("gte".to_string(), json!(value));
                }
                if let Some(value) = filters.size_max {
                    range.insert("lte".to_string(), json!(value));
                }
                filter.push(json!({ "range": { "size_bytes": range } }));
            }
            if filters.date_from.is_some() || filters.date_to.is_some() {
                let mut range = serde_json::Map::new();
                if let Some(ref value) = filters.date_from {
                    range.insert("gte".to_string(), json!(value));
                }
                if let Some(ref value) = filters.date_to {
                    range.insert("lte".to_string(), json!(value));
                }
                filter.push(json!({ "range": { "modified_at": range } }));
            }
        }
        let payload = json!({
            "from": offset,
            "size": limit,
            "track_total_hits": true,
            "_source": ["file_id"],
            "query": {
                "bool": {
                    "must": [{ "simple_query_string": {
                        "query": query,
                        "fields": ["file_name^4", "title^3", "keywords^2", "author", "content"],
                        "default_operator": "and"
                    }}],
                    "filter": filter
                }
            }
        });
        let response = self
            .client
            .post(format!("{}/{}/_search", endpoint, INDEX_NAME))
            .json(&payload)
            .send()
            .map_err(|e| e.to_string())?;
        let value = ensure_success_json(response, "search Elasticsearch")?;
        let hits = value
            .pointer("/hits/hits")
            .and_then(Value::as_array)
            .ok_or_else(|| "Elasticsearch response has no hits".to_string())?;
        let results = hits
            .iter()
            .filter_map(|hit| {
                Some(SearchHit {
                    file_id: hit.pointer("/_source/file_id")?.as_i64()?,
                    score: hit.get("_score").and_then(Value::as_f64).unwrap_or(0.0) as f32,
                })
            })
            .collect();
        let total = value
            .pointer("/hits/total/value")
            .and_then(Value::as_u64)
            .or_else(|| value.pointer("/hits/total").and_then(Value::as_u64))
            .ok_or_else(|| "Elasticsearch response has no total hit count".to_string())?;
        Ok(Some(super::engine::SearchPage {
            hits: results,
            total,
        }))
    }

    pub fn status(&self) -> SearchBackendStatus {
        SearchBackendStatus {
            backend: if self.is_ready() {
                "elasticsearch"
            } else {
                "tantivy-fallback"
            }
            .to_string(),
            connected: self.is_ready(),
            endpoint: self.endpoint.read().ok().and_then(|value| value.clone()),
            version: self.version.read().ok().and_then(|value| value.clone()),
            error: self.error.read().ok().and_then(|value| value.clone()),
        }
    }

    fn ensure_index(&self, endpoint: &str) -> Result<(), String> {
        let exists = self
            .client
            .head(format!("{}/{}", endpoint, INDEX_NAME))
            .send()
            .map_err(|e| e.to_string())?;
        if exists.status().is_success() {
            return Ok(());
        }
        let mapping = json!({
            "settings": {
                "index.max_ngram_diff": 2,
                "analysis": {
                    "tokenizer": { "xd_ngram": { "type": "ngram", "min_gram": 1, "max_gram": 3, "token_chars": ["letter", "digit"] } },
                    "analyzer": { "xd_text": { "type": "custom", "tokenizer": "xd_ngram", "filter": ["lowercase"] } }
                }
            },
            "mappings": { "properties": {
                "file_id": { "type": "long" }, "folder_id": { "type": "long" },
                "file_name": { "type": "text", "analyzer": "xd_text" },
                "content": { "type": "text", "analyzer": "xd_text" },
                "title": { "type": "text", "analyzer": "xd_text" },
                "author": { "type": "text", "analyzer": "xd_text" },
                "keywords": { "type": "text", "analyzer": "xd_text" },
                "extension": { "type": "keyword" }, "modified_at": { "type": "keyword" },
                "size_bytes": { "type": "long" }
            }}
        });
        let response = self
            .client
            .put(format!("{}/{}", endpoint, INDEX_NAME))
            .json(&mapping)
            .send()
            .map_err(|e| e.to_string())?;
        ensure_success(response, "create Elasticsearch index")
    }

    fn endpoint(&self) -> Result<Option<String>, String> {
        self.endpoint
            .read()
            .map(|value| value.clone())
            .map_err(|e| e.to_string())
    }

    fn send_bulk(
        &self,
        endpoint: &str,
        body: String,
        wait_for_refresh: bool,
    ) -> Result<(), String> {
        let response = self
            .client
            .post(format!("{}/_bulk", endpoint))
            // Incremental writes must be searchable before reporting completion.
            // Full rebuilds perform a single explicit refresh after all batches.
            .query(&[(
                "refresh",
                if wait_for_refresh {
                    "wait_for"
                } else {
                    "false"
                },
            )])
            .header("content-type", "application/x-ndjson")
            .body(body)
            .send()
            .map_err(|e| e.to_string())?;
        let value = ensure_success_json(response, "bulk index Elasticsearch documents")?;
        if bulk_has_fatal_errors(&value) {
            return Err("Elasticsearch bulk indexing returned document errors".to_string());
        }
        Ok(())
    }

    fn fail<T>(&self, message: String) -> Result<T, String> {
        if let Ok(mut error) = self.error.write() {
            *error = Some(message.clone());
        }
        Err(message)
    }

    fn disable<T>(&self, message: String) -> Result<T, String> {
        if let Ok(mut endpoint) = self.endpoint.write() {
            *endpoint = None;
        }
        if let Ok(mut version) = self.version.write() {
            *version = None;
        }
        self.fail(message)
    }
}

fn bulk_has_fatal_errors(value: &Value) -> bool {
    if value.get("errors").and_then(Value::as_bool) != Some(true) {
        return false;
    }
    value
        .get("items")
        .and_then(Value::as_array)
        .map_or(true, |items| {
            items.iter().any(|item| {
                item.as_object().map_or(true, |actions| {
                    actions.iter().any(|(action, result)| {
                        let status = result.get("status").and_then(Value::as_u64).unwrap_or(500);
                        status >= 300 && !(action == "delete" && status == 404)
                    })
                })
            })
        })
}

fn append_bulk_line(body: &mut String, value: &impl serde::Serialize) -> Result<(), String> {
    body.push_str(&serde_json::to_string(value).map_err(|error| error.to_string())?);
    body.push('\n');
    Ok(())
}

impl Drop for ElasticRuntime {
    fn drop(&mut self) {
        #[cfg(windows)]
        if let Ok(mut handle) = self.job_handle.lock() {
            if let Some(handle) = handle.take() {
                unsafe { windows_sys::Win32::Foundation::CloseHandle(handle as _) };
            }
        }
        if let Ok(mut process) = self.process.lock() {
            if let Some(mut child) = process.take() {
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let _ = Command::new("taskkill")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .creation_flags(0x08000000)
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(windows)]
fn create_kill_on_close_job(child: &Child) -> Result<isize, String> {
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::AsRawHandle;
    use std::ptr::null;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let handle = unsafe { CreateJobObjectW(null(), null()) };
    if handle.is_null() {
        return Err(format!(
            "Cannot create Elasticsearch process job: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
    information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &information as *const _ as _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    let assigned = if configured != 0 {
        unsafe { AssignProcessToJobObject(handle, child.as_raw_handle() as _) }
    } else {
        0
    };
    if configured == 0 || assigned == 0 {
        let error = std::io::Error::last_os_error();
        unsafe { CloseHandle(handle) };
        return Err(format!(
            "Cannot attach Elasticsearch to the application job: {}",
            error
        ));
    }
    Ok(handle as isize)
}

fn resolve_distribution_dir(path: &Path) -> Result<PathBuf, String> {
    if is_elasticsearch_distribution(path) {
        return Ok(path.to_path_buf());
    }
    let entries = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        if is_elasticsearch_distribution(&candidate) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "No Elasticsearch distribution found under {}",
        path.display()
    ))
}

fn is_elasticsearch_distribution(path: &Path) -> bool {
    elasticsearch_launcher(path).is_file()
}

fn elasticsearch_launcher(path: &Path) -> PathBuf {
    path.join("bin").join(if cfg!(windows) {
        "elasticsearch.bat"
    } else {
        "elasticsearch"
    })
}

fn prepare_runtime_config(
    source: &Path,
    destination: &Path,
    data_dir: &Path,
    logs_dir: &Path,
) -> Result<(), String> {
    copy_directory(source, destination)?;

    let jvm_options_path = destination.join("jvm.options");
    let options = std::fs::read_to_string(&jvm_options_path).map_err(|e| e.to_string())?;
    let mut rewritten = Vec::new();
    for line in options.lines() {
        if line.starts_with("-Xlog:gc") && line.contains("file=logs/gc.log") {
            continue;
        }
        if line.starts_with("-XX:HeapDumpPath=") {
            rewritten.push(format!("-XX:HeapDumpPath={}", data_dir.display()));
        } else if line.starts_with("-XX:ErrorFile=") {
            rewritten.push(format!(
                "-XX:ErrorFile={}",
                logs_dir.join("hs_err_pid%p.log").display()
            ));
        } else {
            rewritten.push(line.to_string());
        }
    }
    std::fs::write(jvm_options_path, format!("{}\n", rewritten.join("\n")))
        .map_err(|e| e.to_string())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else {
            std::fs::copy(source_path, destination_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{bulk_has_fatal_errors, prepare_runtime_config, ElasticRuntime};
    use serde_json::{json, Value};

    #[test]
    fn runtime_config_keeps_jvm_writes_out_of_the_distribution() {
        let root = std::env::temp_dir().join(format!(
            "xdocuments-elastic-config-{}",
            uuid::Uuid::new_v4()
        ));
        let source = root.join("source");
        let destination = root.join("runtime");
        let data = root.join("data");
        let logs = root.join("logs");
        std::fs::create_dir_all(source.join("jvm.options.d")).unwrap();
        std::fs::write(source.join("elasticsearch.yml"), "cluster.name: test\n").unwrap();
        std::fs::write(
            source.join("jvm.options"),
            "-Xms1g\n-XX:HeapDumpPath=data\n-XX:ErrorFile=logs/hs_err_pid%p.log\n-Xlog:gc*:file=logs/gc.log:time\n",
        )
        .unwrap();

        prepare_runtime_config(&source, &destination, &data, &logs).unwrap();

        let options = std::fs::read_to_string(destination.join("jvm.options")).unwrap();
        assert!(!options.contains("logs/gc.log"));
        assert!(options.contains(&format!("-XX:HeapDumpPath={}", data.display())));
        assert!(options.contains(&format!(
            "-XX:ErrorFile={}",
            logs.join("hs_err_pid%p.log").display()
        )));
        assert!(destination.join("elasticsearch.yml").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bulk_delete_ignores_missing_documents_but_keeps_real_errors() {
        assert!(!bulk_has_fatal_errors(&json!({
            "errors": true,
            "items": [{ "delete": { "status": 404 } }, { "index": { "status": 201 } }]
        })));
        assert!(bulk_has_fatal_errors(&json!({
            "errors": true,
            "items": [{ "index": { "status": 400 } }]
        })));
    }

    #[test]
    fn incremental_bulk_waits_for_visibility_without_refreshing_each_rebuild_batch() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;
        use std::time::Duration;

        for incremental in [true, false] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let endpoint = format!("http://{}", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                reader.read_exact(&mut vec![0; length]).unwrap();
                let body = r#"{"errors":false,"items":[]}"#;
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
                request_line
            });
            let runtime = ElasticRuntime::new().unwrap();
            if incremental {
                runtime.apply_changes_inner(&endpoint, &[], &[42]).unwrap();
            } else {
                runtime
                    .send_bulk(&endpoint, "{}\n".to_string(), false)
                    .unwrap();
            }
            let refresh = if incremental { "wait_for" } else { "false" };
            assert_eq!(
                server.join().unwrap(),
                format!("POST /_bulk?refresh={refresh} HTTP/1.1\r\n")
            );
        }
    }

    #[test]
    fn search_sends_pagination_and_returns_exact_total() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;
        use std::time::Duration;

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            let mut request_body = vec![0; length];
            reader.read_exact(&mut request_body).unwrap();
            let response = r#"{"hits":{"total":{"value":123,"relation":"eq"},"hits":[{"_score":2.5,"_source":{"file_id":42}}]}}"#;
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
            (
                request_line,
                serde_json::from_slice::<Value>(&request_body).unwrap(),
            )
        });
        let runtime = ElasticRuntime::new().unwrap();
        *runtime.endpoint.write().unwrap() = Some(endpoint);
        *runtime.version.write().unwrap() = Some("8.17.0".to_string());

        let page = runtime.search("audit", None, 25, 10).unwrap().unwrap();

        assert_eq!(page.total, 123);
        assert_eq!(page.hits[0].file_id, 42);
        let (request_line, body) = server.join().unwrap();
        assert_eq!(request_line, "POST /xdocuments-v1/_search HTTP/1.1\r\n");
        assert_eq!(body["from"], 25);
        assert_eq!(body["size"], 10);
        assert_eq!(body["track_total_hits"], true);
    }

    #[test]
    fn failed_incremental_update_disables_elasticsearch_and_records_the_error() {
        let runtime = ElasticRuntime::new().unwrap();
        *runtime.endpoint.write().unwrap() = Some("not a valid endpoint".to_string());
        *runtime.version.write().unwrap() = Some("8.17.0".to_string());

        let error = runtime.apply_changes(&[], &[42]).unwrap_err();

        assert!(error.starts_with("Elasticsearch incremental update failed"));
        let status = runtime.status();
        assert_eq!(status.backend, "tantivy-fallback");
        assert!(!status.connected);
        assert_eq!(status.endpoint, None);
        assert_eq!(status.version, None);
        assert_eq!(status.error.as_deref(), Some(error.as_str()));
    }
}

fn reserve_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|e| e.to_string())
}

fn append_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())
}

fn ensure_success(response: reqwest::blocking::Response, operation: &str) -> Result<(), String> {
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let body = response.text().unwrap_or_default();
    Err(format!("Failed to {} ({}): {}", operation, status, body))
}

fn ensure_success_json(
    response: reqwest::blocking::Response,
    operation: &str,
) -> Result<Value, String> {
    let status = response.status();
    let body = response.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Failed to {} ({}): {}", operation, status, body));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}
