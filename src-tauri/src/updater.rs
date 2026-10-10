use crate::{background, commands::ocr_control::OcrTaskManager, db::Database};
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use rusqlite::OptionalExtension;
use serde::Serialize;
use std::{
    io::Read,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::io::AsyncWriteExt;

const MAX_UPDATE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: &'static str,
    pub version: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

pub struct UpdateManager {
    status: Mutex<UpdateStatus>,
    operation: tokio::sync::Mutex<Option<Update>>,
    startup_checked: AtomicBool,
}

impl Default for UpdateManager {
    fn default() -> Self {
        Self {
            status: Mutex::new(UpdateStatus {
                phase: "idle",
                ..Default::default()
            }),
            operation: tokio::sync::Mutex::new(None),
            startup_checked: AtomicBool::new(false),
        }
    }
}

impl UpdateManager {
    fn set_phase(&self, phase: &'static str) {
        let mut state = self.status.lock().unwrap();
        state.phase = phase;
        state.error = None;
    }

    fn fail(&self, error: &str, fallback: &'static str) {
        log::warn!("Application update: {error}");
        let mut state = self.status.lock().unwrap();
        state.phase = fallback;
        state.error = Some(error.to_string());
    }
}

#[tauri::command]
pub fn get_app_update_status(state: tauri::State<'_, UpdateManager>) -> UpdateStatus {
    state.status.lock().unwrap().clone()
}

async fn preferences(app: AppHandle) -> Result<(bool, bool), String> {
    background::run(move || {
        let db = background::state::<Database>(&app)?;
        let conn = db.get_connection();
        let enabled = |key| -> Result<bool, String> {
            let value: Option<String> = conn
                .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(|e| e.to_string())?;
            Ok(value.as_deref() != Some("false"))
        };
        Ok((
            enabled("updates_check_on_startup")?,
            enabled("updates_auto_download")?,
        ))
    })
    .await
}

#[tauri::command]
pub async fn check_app_update(app: AppHandle, startup: bool) -> Result<(), String> {
    let manager = app.state::<UpdateManager>();
    // React StrictMode and repeated startup notifications must not duplicate a check.
    if startup && manager.startup_checked.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let (check_on_startup, auto_download) = preferences(app.clone()).await?;
    if startup && !check_on_startup {
        return Ok(());
    }
    let mut pending = manager
        .operation
        .try_lock()
        .map_err(|_| "Update operation in progress")?;
    let previous = manager.status.lock().unwrap().clone();
    manager.set_phase("checking");
    let result = async {
        let update = app
            .updater_builder()
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?;
        match update {
            Some(update) => {
                validate_download_url(update.download_url.as_str())?;
                *manager.status.lock().unwrap() = UpdateStatus {
                    phase: "available",
                    version: Some(update.version.clone()),
                    ..Default::default()
                };
                *pending = Some(update);
                if auto_download {
                    download(&app, pending.as_ref().unwrap(), &manager).await?;
                }
            }
            None => {
                *pending = None;
                *manager.status.lock().unwrap() = UpdateStatus {
                    phase: "up_to_date",
                    ..Default::default()
                };
                // Remove an already installed package without holding the UI thread.
                if let Ok(cache) = cache_path(&app) {
                    let _ = tokio::fs::remove_file(cache).await;
                }
            }
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = &result {
        let phase = manager.status.lock().unwrap().phase;
        if phase == "checking" && previous.phase == "ready" {
            *manager.status.lock().unwrap() = previous;
            manager.fail(error, "ready");
        } else {
            manager.fail(
                error,
                if pending.is_some() {
                    "available"
                } else {
                    "error"
                },
            );
        }
    }
    result
}

#[tauri::command]
pub async fn download_app_update(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<UpdateManager>();
    let pending = manager
        .operation
        .try_lock()
        .map_err(|_| "Update operation in progress")?;
    let update = pending.as_ref().ok_or("Check for an update first")?;
    let result = download(&app, update, &manager).await;
    if let Err(error) = &result {
        manager.fail(error, "available");
    }
    result
}

fn cache_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("updates")
        .join("package.bin"))
}

fn public_key(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|c| c.get("pubkey"))
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "Missing updater public key".into())
}

// Limit update sources to this project's HTTPS releases. GitHub's asset redirect uses HTTPS too.
fn validate_download_url(url: &str) -> Result<(), String> {
    if url.starts_with("https://github.com/YunyingTech/XDocumentsmanager/releases/download/") {
        Ok(())
    } else {
        Err("Unexpected update download URL".into())
    }
}

async fn download(app: &AppHandle, update: &Update, manager: &UpdateManager) -> Result<(), String> {
    let cache = cache_path(app)?;
    let key = public_key(app)?;
    manager.set_phase("verifying");
    let (path, signature, version, pubkey) = (
        cache.clone(),
        update.signature.clone(),
        update.version.clone(),
        key.clone(),
    );
    let cached = background::run(move || verify_file(&path, &signature, &pubkey, &version))
        .await
        .is_ok();
    if cached {
        manager.set_phase("ready");
        return Ok(());
    }
    tokio::fs::create_dir_all(cache.parent().unwrap())
        .await
        .map_err(|e| e.to_string())?;
    let part = cache.with_extension("part");
    manager.set_phase("downloading");
    {
        let mut state = manager.status.lock().unwrap();
        state.downloaded = 0;
        state.total = None;
    }
    let result = async {
        let client = reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60))
            .timeout(Duration::from_secs(7200))
            .user_agent(concat!("XDocuments/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| e.to_string())?;
        let mut response = client
            .get(update.download_url.as_str())
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let total = response.content_length();
        if total.is_some_and(|size| size > MAX_UPDATE_BYTES) {
            return Err("Update package exceeds the 2 GiB download limit".into());
        }
        let mut file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| e.to_string())?;
        let mut downloaded = 0u64;
        let mut last_progress = Instant::now();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if downloaded.saturating_add(chunk.len() as u64) > MAX_UPDATE_BYTES {
                return Err("Update package exceeds the 2 GiB download limit".into());
            }
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;
            if last_progress.elapsed() >= Duration::from_millis(200) {
                let mut status = manager.status.lock().unwrap();
                status.downloaded = downloaded;
                status.total = total;
                last_progress = Instant::now();
            }
        }
        file.sync_all().await.map_err(|e| e.to_string())?;
        drop(file);
        if total.is_some_and(|size| size != downloaded) {
            return Err("Incomplete update download".into());
        }
        {
            let mut status = manager.status.lock().unwrap();
            status.downloaded = downloaded;
            status.total = total;
        }
        manager.set_phase("verifying");
        let (path, signature, version) = (
            part.clone(),
            update.signature.clone(),
            update.version.clone(),
        );
        background::run(move || verify_file(&path, &signature, &key, &version)).await?;
        if tokio::fs::try_exists(&cache)
            .await
            .map_err(|e| e.to_string())?
        {
            tokio::fs::remove_file(&cache)
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::rename(&part, &cache)
            .await
            .map_err(|e| e.to_string())?;
        manager.set_phase("ready");
        Ok::<(), String>(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(part).await;
    }
    result
}

fn decode(text: &str) -> Result<String, String> {
    String::from_utf8(STANDARD.decode(text.trim()).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn check_signed_version(signature: &Signature, version: &str) -> Result<(), String> {
    // Older Tauri signing CLIs omit this field. Check it whenever it is present.
    if let Some(signed) = signature
        .trusted_comment()
        .split('\t')
        .find_map(|v| v.strip_prefix("version:"))
    {
        let signed =
            semver::Version::parse(signed.trim_start_matches('v')).map_err(|e| e.to_string())?;
        let announced =
            semver::Version::parse(version.trim_start_matches('v')).map_err(|e| e.to_string())?;
        if signed != announced {
            return Err("Signed update version does not match release".into());
        }
    }
    Ok(())
}

fn verify_file(path: &Path, signature: &str, key: &str, version: &str) -> Result<(), String> {
    let key = PublicKey::decode(&decode(key)?).map_err(|e| e.to_string())?;
    let signature = Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    let mut verifier = key.verify_stream(&signature).map_err(|e| e.to_string())?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        verifier.update(&buffer[..read]);
    }
    verifier
        .finalize()
        .map_err(|e| format!("Update signature verification failed: {e}"))?;
    check_signed_version(&signature, version)
}

#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<UpdateManager>();
    let pending = manager
        .operation
        .try_lock()
        .map_err(|_| "Update operation in progress")?;
    if manager.status.lock().unwrap().phase != "ready" {
        return Err("Download and verify the update first".into());
    }
    let update = pending.as_ref().ok_or("No pending update")?.clone();
    let app_for_install = app.clone();
    manager.set_phase("installing");
    let result = background::run(move || {
        let db = background::state::<Database>(&app_for_install)?;
        let tasks = background::state::<OcrTaskManager>(&app_for_install)?;
        // Hold the DB lock until installation starts: an index job cannot be queued in between.
        let conn = db.get_connection();
        if has_index_jobs(&conn)? {
            return Err("Wait for indexing tasks to finish before installing".into());
        }
        let _ocr_guard = tasks.begin_update()?;
        let cache = cache_path(&app_for_install)?;
        let bytes = std::fs::read(&cache).map_err(|e| e.to_string())?;
        // Revalidate the exact bytes passed to the installer, including changes to the disk cache.
        let key = PublicKey::decode(&decode(&public_key(&app_for_install)?)?)
            .map_err(|e| e.to_string())?;
        let signature =
            Signature::decode(&decode(&update.signature)?).map_err(|e| e.to_string())?;
        key.verify(&bytes, &signature, false)
            .map_err(|e| format!("Update signature verification failed: {e}"))?;
        check_signed_version(&signature, &update.version)?;
        update.install(bytes).map_err(|e| e.to_string())?;
        #[cfg(not(windows))]
        app_for_install.restart();
        #[allow(unreachable_code)]
        Ok(())
    })
    .await;
    if let Err(error) = &result {
        manager.fail(error, "ready");
    }
    result
}

fn has_index_jobs(conn: &rusqlite::Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM index_jobs WHERE status IN ('queued','running','paused'))",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_sources_must_be_project_release_assets_over_https() {
        assert!(validate_download_url("https://github.com/YunyingTech/XDocumentsmanager/releases/download/v0.1.11/XDocuments.exe").is_ok());
        assert!(validate_download_url("http://github.com/YunyingTech/XDocumentsmanager/releases/download/v0.1.11/XDocuments.exe").is_err());
        assert!(validate_download_url(
            "https://example.com/releases/download/v0.1.11/XDocuments.exe"
        )
        .is_err());
    }

    #[test]
    fn install_guard_detects_queued_running_and_paused_index_jobs() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute("CREATE TABLE index_jobs (status TEXT)", [])
            .unwrap();
        assert!(!has_index_jobs(&connection).unwrap());
        for status in ["queued", "running", "paused"] {
            connection.execute("DELETE FROM index_jobs", []).unwrap();
            connection
                .execute("INSERT INTO index_jobs (status) VALUES (?1)", [status])
                .unwrap();
            assert!(has_index_jobs(&connection).unwrap());
        }
        connection.execute("DELETE FROM index_jobs", []).unwrap();
        connection
            .execute("INSERT INTO index_jobs (status) VALUES ('completed')", [])
            .unwrap();
        assert!(!has_index_jobs(&connection).unwrap());
    }
}
