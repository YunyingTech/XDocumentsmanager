use tauri::State;
use crate::db::Database;
use serde::{Deserialize, Serialize};

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
    let mut stmt = conn
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
        Err(e) => Ok(OcrHealthInfo {
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
) -> Result<String, String> {
    let api_url = get_ocr_api_url(&db);
    let output_dir = resolve_output_dir(&db)?;

    // Get file name for output naming
    let (file_name, ocr_applied) = {
        let conn = db.get_connection();
        let mut stmt = conn
            .prepare("SELECT file_name, ocr_applied FROM files WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        stmt.query_row([file_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i32>(1)? != 0,
            ))
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

    // Mark file as OCR-processed
    {
        let conn = db.get_connection();
        conn.execute(
            "UPDATE files SET ocr_applied = 1 WHERE id = ?1",
            rusqlite::params![file_id],
        )
        .map_err(|e| e.to_string())?;
    }

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

    // Mark file as OCR-processed
    {
        let conn = db.get_connection();
        conn.execute(
            "UPDATE files SET ocr_applied = 1 WHERE id = ?1",
            rusqlite::params![file_id],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(output_path.to_string_lossy().to_string())
}

/// Get the configured OCR output directory path.
#[tauri::command]
pub fn get_ocr_output_dir(db: State<'_, Database>) -> Result<String, String> {
    resolve_output_dir(&db)
}

/// List indexed PDF files available for OCR (files with index_status='indexed').
#[tauri::command]
pub fn list_ocr_candidates(
    folder_id: Option<i64>,
    db: State<'_, Database>,
) -> Result<Vec<crate::models::FileInfo>, String> {
    let conn = db.get_connection();

    let sql = if let Some(fid) = folder_id {
        format!(
            "SELECT id, folder_id, relative_path, file_name, file_extension, \
             file_size_bytes, content_hash, page_count, text_length, \
             file_created_at, file_modified_at, indexed_at, index_status, \
             index_error, text_preview, ocr_applied, pdf_title, pdf_author, \
             pdf_subject, pdf_keywords \
             FROM files \
             WHERE folder_id = {} AND index_status = 'indexed' \
             ORDER BY file_name",
            fid
        )
    } else {
        "SELECT id, folder_id, relative_path, file_name, file_extension, \
         file_size_bytes, content_hash, page_count, text_length, \
         file_created_at, file_modified_at, indexed_at, index_status, \
         index_error, text_preview, ocr_applied, pdf_title, pdf_author, \
         pdf_subject, pdf_keywords \
         FROM files \
         WHERE index_status = 'indexed' \
         ORDER BY file_name"
        .to_string()
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| crate::db::row_to_file_info(row))
        .map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    for row in rows {
        files.push(row.map_err(|e| e.to_string())?);
    }
    Ok(files)
}
