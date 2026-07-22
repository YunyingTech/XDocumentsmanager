use tauri::State;
use crate::db::Database;
use crate::models::PaginatedResult;
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read};
use crate::search::{engine::document_for_file, SearchEngine};

// ── Response types for frontend ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrHealthInfo {
    pub protocol_version: String,
    pub processing_window_size: i64,
    pub max_concurrent_requests: i64,
    pub connected: bool,
    pub api_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitTaskResponse {
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrTaskStatus {
    pub task_id: String,
    pub status: String,
    #[serde(default)]
    pub queued_ahead: Option<i64>,
    #[serde(default)]
    pub progress: Option<f64>,
    #[serde(default)]
    pub error_message: Option<String>,
}

// ── Helpers ──

fn get_setting_value(db: &Database, key: &str, default: &str) -> String {
    let conn = db.get_connection();
    let stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .ok();
    match stmt.and_then(|mut s| s.query_row([key], |row| row.get::<_, String>(0)).ok()) {
        Some(v) if !v.is_empty() => v,
        _ => default.to_string(),
    }
}

fn get_ocr_api_url(db: &Database) -> String {
    get_setting_value(db, "ocr_api_url", "http://127.0.0.1:8000")
}

fn resolve_output_dir(db: &Database) -> Result<String, String> {
    let dir = get_setting_value(db, "ocr_output_dir", "");
    if dir.is_empty() {
        let project_dir = std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join("OCR_result");
        Ok(project_dir.to_string_lossy().to_string())
    } else {
        Ok(dir)
    }
}

fn get_file_abs_path(db: &Database, file_id: i64) -> Result<(String, String), String> {
    let conn = db.get_connection();
    let mut stmt = conn
        .prepare(
            "SELECT f.relative_path, f.file_name, wf.path FROM files f \
             JOIN watched_folders wf ON f.folder_id = wf.id \
             WHERE f.id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let (relative_path, file_name, folder_path): (String, String, String) = stmt
        .query_row([file_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| format!("File not found (id={}): {}", file_id, e))?;

    let abs_path = std::path::Path::new(&folder_path)
        .join(&relative_path)
        .to_string_lossy()
        .to_string();

    Ok((abs_path, file_name))
}

fn create_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(600)) // 10 min
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

// ── Commands ──

/// Check MinerU API health. Returns connection status even on failure (connected=false).
#[tauri::command]
pub async fn check_ocr_health(
    db: State<'_, Database>,
) -> Result<OcrHealthInfo, String> {
    let api_url = get_ocr_api_url(&db);
    let client = create_http_client()?;

    match client.get(format!("{}/health", api_url)).send().await {
        Ok(resp) => {
            let json: serde_json::Value =
                resp.json().await.map_err(|e| e.to_string())?;
            Ok(OcrHealthInfo {
                protocol_version: json["protocol_version"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string(),
                processing_window_size: json["processing_window_size"].as_i64().unwrap_or(0),
                max_concurrent_requests: json["max_concurrent_requests"].as_i64().unwrap_or(0),
                connected: true,
                api_url,
            })
        }
        Err(_e) => Ok(OcrHealthInfo {
            protocol_version: String::new(),
            processing_window_size: 0,
            max_concurrent_requests: 0,
            connected: false,
            api_url,
        }),
    }
}

/// Submit a file to MinerU async task endpoint (POST /tasks).
/// Returns the task_id immediately.
#[tauri::command]
pub async fn submit_ocr_task(
    file_id: i64,
    return_md: Option<bool>,
    db: State<'_, Database>,
) -> Result<SubmitTaskResponse, String> {
    let api_url = get_ocr_api_url(&db);
    let (file_path, file_name) = get_file_abs_path(&db, file_id)?;
    let client = create_http_client()?;

    // Read file bytes (before HTTP call, scoped)
    let file_bytes = std::fs::read(&file_path)
        .map_err(|e| format!("Cannot read file '{}': {}", file_path, e))?;

    // Build multipart form
    let file_part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name.clone())
        .mime_str("application/pdf")
        .map_err(|e| e.to_string())?;

    let mut form = reqwest::multipart::Form::new().part("files", file_part);

    if return_md.unwrap_or(true) {
        form = form.text("return_md", "true");
    }

    let resp = client
        .post(format!("{}/tasks", api_url))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to submit OCR task to {}: {}", api_url, e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("MinerU API error ({}): {}", status, body));
    }

    let result: SubmitTaskResponse = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response from MinerU: {}", e))?;

    Ok(result)
}

/// Query task status (GET /tasks/{task_id}).
#[tauri::command]
pub async fn query_ocr_task(
    task_id: String,
    db: State<'_, Database>,
) -> Result<OcrTaskStatus, String> {
    let api_url = get_ocr_api_url(&db);
    let client = create_http_client()?;

    let resp = client
        .get(format!("{}/tasks/{}", api_url, task_id))
        .send()
        .await
        .map_err(|e| format!("Failed to query task: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("MinerU API error ({}): {}", status, body));
    }

    let json: serde_json::Value =
        resp.json().await.map_err(|e| format!("Invalid response: {}", e))?;

    Ok(OcrTaskStatus {
        task_id,
        status: json["status"].as_str().unwrap_or("unknown").to_string(),
        queued_ahead: json["queued_ahead"].as_i64(),
        progress: json["progress"].as_f64(),
        error_message: json["error_message"].as_str().map(|s| s.to_string()),
    })
}

/// Download and save OCR result (GET /tasks/{task_id}/result).
/// Returns the saved file path.
#[tauri::command]
pub async fn get_ocr_result(
    task_id: String,
    file_id: i64,
    db: State<'_, Database>,
    engine: State<'_, SearchEngine>,
) -> Result<String, String> {
    let api_url = get_ocr_api_url(&db);
    let output_dir = resolve_output_dir(&db)?;

    // Get file name for output naming
    let file_name = {
        let conn = db.get_connection();
        let mut stmt = conn
            .prepare("SELECT file_name, ocr_applied FROM files WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        stmt.query_row([file_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("File not found (id={}): {}", file_id, e))?
    };

    let client = create_http_client()?;

    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Cannot create output directory '{}': {}", output_dir, e))?;

    let resp = client
        .get(format!("{}/tasks/{}/result", api_url, task_id))
        .send()
        .await
        .map_err(|e| format!("Failed to get task result: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("MinerU API error ({}): {}", status, body));
    }

    // Determine output format from content-type
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response bytes: {}", e))?;

    let ext = if content_type.contains("zip") {
        "zip"
    } else {
        "md"
    };

    let file_stem = std::path::Path::new(&file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("file_{}", file_id));

    // Include task_id prefix to avoid overwrites
    let output_path = std::path::Path::new(&output_dir)
        .join(format!("{}_{}.{}", file_stem, &task_id[..8.min(task_id.len())], ext));

    std::fs::write(&output_path, &bytes)
        .map_err(|e| format!("Cannot write OCR result: {}", e))?;

    persist_ocr_text(&db, &engine, file_id, &bytes, ext == "zip")?;

    Ok(output_path.to_string_lossy().to_string())
}

/// Synchronous parse via POST /file_parse. Blocks until complete.
/// Returns the saved file path.
#[tauri::command]
pub async fn sync_ocr_parse(
    file_id: i64,
    return_md: Option<bool>,
    response_format_zip: Option<bool>,
    db: State<'_, Database>,
    engine: State<'_, SearchEngine>,
) -> Result<String, String> {
    let api_url = get_ocr_api_url(&db);
    let (file_path, file_name) = get_file_abs_path(&db, file_id)?;
    let output_dir = resolve_output_dir(&db)?;
    let client = create_http_client()?;

    let file_bytes = std::fs::read(&file_path)
        .map_err(|e| format!("Cannot read file '{}': {}", file_path, e))?;

    let file_part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name.clone())
        .mime_str("application/pdf")
        .map_err(|e| e.to_string())?;

    let mut form = reqwest::multipart::Form::new().part("files", file_part);

    if return_md.unwrap_or(true) {
        form = form.text("return_md", "true");
    }
    if response_format_zip.unwrap_or(false) {
        form = form.text("response_format_zip", "true");
    }

    let resp = client
        .post(format!("{}/file_parse", api_url))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to parse file: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("MinerU API error ({}): {}", status, body));
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Cannot create output dir '{}': {}", output_dir, e))?;

    let ext = if content_type.contains("zip") {
        "zip"
    } else {
        "md"
    };

    let file_stem = std::path::Path::new(&file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("file_{}", file_id));

    let output_path = std::path::Path::new(&output_dir).join(format!("{}.{}", file_stem, ext));

    std::fs::write(&output_path, &bytes)
        .map_err(|e| format!("Cannot write OCR result: {}", e))?;

    persist_ocr_text(&db, &engine, file_id, &bytes, ext == "zip")?;

    Ok(output_path.to_string_lossy().to_string())
}

fn persist_ocr_text(
    db: &Database,
    engine: &SearchEngine,
    file_id: i64,
    bytes: &[u8],
    is_zip: bool,
) -> Result<(), String> {
    let text = if is_zip { markdown_from_zip(bytes)? } else { String::from_utf8_lossy(bytes).into_owned() };
    if text.trim().is_empty() {
        return Err("OCR result did not contain Markdown text".to_string());
    }
    let document = {
        let conn = db.get_connection();
        conn.execute(
            "UPDATE files SET text_preview = ?1, text_length = ?2, ocr_applied = 1, indexed_at = datetime('now') WHERE id = ?3",
            rusqlite::params![text, text.chars().count() as i64, file_id],
        ).map_err(|e| e.to_string())?;
        document_for_file(&conn, file_id)?
    };
    engine.upsert(document)
}

fn markdown_from_zip(bytes: &[u8]) -> Result<String, String> {
    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid OCR ZIP result: {}", e))?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|e| e.to_string())?;
        if file.name().to_ascii_lowercase().ends_with(".md") {
            let mut text = String::new();
            file.read_to_string(&mut text).map_err(|e| format!("Cannot read Markdown from OCR ZIP: {}", e))?;
            return Ok(text);
        }
    }
    Err("OCR ZIP result contains no Markdown file".to_string())
}

#[cfg(test)]
mod tests {
    use super::{markdown_from_zip, persist_ocr_text};
    use crate::db::Database;
    use crate::search::SearchEngine;
    use std::io::{Cursor, Write};
    use std::path::PathBuf;

    #[test]
    fn extracts_markdown_from_zip_result() {
        let mut output = Cursor::new(Vec::new());
        {
            let mut archive = zip::ZipWriter::new(&mut output);
            archive.start_file("result/document.md", zip::write::SimpleFileOptions::default()).unwrap();
            archive.write_all("# OCR result\nneedle".as_bytes()).unwrap();
            archive.finish().unwrap();
        }
        assert!(markdown_from_zip(output.get_ref()).unwrap().contains("needle"));
    }

    #[test]
    #[ignore = "requires the bundled Elasticsearch Windows runtime"]
    fn ocr_text_is_upserted_to_real_elasticsearch() {
        let distribution = std::env::var("XDOCUMENTS_ELASTICSEARCH_HOME")
            .expect("XDOCUMENTS_ELASTICSEARCH_HOME must point to the Elasticsearch distribution");
        let root = std::env::temp_dir().join(format!("xdocuments-es-ocr-{}", uuid::Uuid::new_v4()));
        let database = Database::new(&root).unwrap();
        {
            let conn = database.get_connection();
            conn.execute(
                "INSERT INTO watched_folders (id, path, display_name) VALUES (1, 'C:/documents', 'Test')",
                [],
            ).unwrap();
            conn.execute(
                "INSERT INTO files (id, folder_id, relative_path, file_name, file_size_bytes, content_hash, file_modified_at, index_status) VALUES (41, 1, 'source.pdf', 'source.pdf', 100, 'hash', '2026-01-01T00:00:00', 'indexed')",
                [],
            ).unwrap();
        }
        let engine = SearchEngine::open(&root.join("tantivy")).unwrap();
        engine.configure_elasticsearch(
            PathBuf::from(distribution),
            root.join("elastic-data"),
            root.join("elastic-logs"),
        );
        engine.start_elasticsearch().unwrap();

        persist_ocr_text(
            &database,
            &engine,
            41,
            "# OCR\nunique-elastic-ocr-token 供应商审计".as_bytes(),
            false,
        ).unwrap();

        assert_eq!(engine.backend_status().backend, "elasticsearch");
        assert_eq!(engine.search("unique-elastic-ocr-token", None, 10).unwrap()[0].file_id, 41);
        assert_eq!(engine.search("供应商审计", None, 10).unwrap()[0].file_id, 41);
        drop(engine);
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }
}

/// Get the configured OCR output directory path.
#[tauri::command]
pub fn get_ocr_output_dir(db: State<'_, Database>) -> Result<String, String> {
    resolve_output_dir(&db)
}

/// List indexed PDF files available for OCR (files with index_status='indexed').
/// Supports pagination via `page` (0-indexed) and `page_size`.
#[tauri::command]
pub fn list_ocr_candidates(
    folder_id: Option<i64>,
    page: i64,
    page_size: i64,
    db: State<'_, Database>,
) -> Result<PaginatedResult<crate::models::FileInfo>, String> {
    let conn = db.get_connection();

    // Build WHERE clause shared by COUNT and data queries
    let where_clause = if let Some(fid) = folder_id {
        format!("folder_id = {} AND index_status = 'indexed'", fid)
    } else {
        "index_status = 'indexed'".to_string()
    };

    // Get total count
    let count_sql = format!("SELECT COUNT(*) FROM files WHERE {}", where_clause);
    let total: i64 = conn
        .query_row(&count_sql, [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    let total_pages = if total == 0 {
        0
    } else {
        ((total as f64) / (page_size as f64)).ceil() as i64
    };
    let offset = page * page_size;

    // Fetch page
    let sql = format!(
        "SELECT id, folder_id, relative_path, file_name, file_extension, \
         file_size_bytes, content_hash, page_count, text_length, \
         file_created_at, file_modified_at, indexed_at, index_status, \
         index_error, text_preview, ocr_applied, pdf_title, pdf_author, \
         pdf_subject, pdf_keywords \
         FROM files \
         WHERE {} \
         ORDER BY file_name \
         LIMIT {} OFFSET {}",
        where_clause, page_size, offset
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| crate::db::row_to_file_info(row))
        .map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    for row in rows {
        files.push(row.map_err(|e| e.to_string())?);
    }

    Ok(PaginatedResult {
        items: files,
        total,
        page,
        page_size,
        total_pages,
    })
}
