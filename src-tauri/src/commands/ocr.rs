use crate::commands::ocr_control::OcrTaskManager;
use crate::db::Database;
use crate::models::PaginatedResult;
use crate::search::{
    engine::{document_for_file, normalize_cjk_ocr_spacing},
    SearchEngine,
};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

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

#[derive(Debug, Clone, Serialize)]
pub struct WindowsOcrLanguage {
    pub tag: String,
    pub display_name: String,
    pub native_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowsOcrStatus {
    pub available: bool,
    pub languages: Vec<WindowsOcrLanguage>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowsOcrProgress {
    pub task_id: String,
    pub file_id: i64,
    pub processed_pages: u32,
    pub total_pages: u32,
    pub progress: f64,
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

pub(crate) fn resolve_output_dir(db: &Database) -> Result<String, String> {
    let dir = get_setting_value(db, "ocr_output_dir", "");
    if dir.is_empty() {
        let app_data_dir = db
            .path()
            .parent()
            .ok_or_else(|| "Cannot resolve the application data directory".to_string())?;
        Ok(app_data_dir
            .join("OCR_result")
            .to_string_lossy()
            .to_string())
    } else {
        Ok(dir)
    }
}

pub(crate) fn get_file_abs_path(db: &Database, file_id: i64) -> Result<(String, String), String> {
    let conn = db.get_connection();
    let mut stmt = conn
        .prepare(
            "SELECT f.relative_path, f.file_name, wf.path FROM files f \
             JOIN watched_folders wf ON f.folder_id = wf.id \
             WHERE f.id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let (relative_path, file_name, folder_path): (String, String, String) = stmt
        .query_row([file_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
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
pub async fn check_ocr_health(db: State<'_, Database>) -> Result<OcrHealthInfo, String> {
    let api_url = get_ocr_api_url(&db);
    let client = create_http_client()?;

    match client.get(format!("{}/health", api_url)).send().await {
        Ok(resp) => {
            let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
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

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;

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
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<String, String> {
    let api_url = get_ocr_api_url(&db);
    let output_dir = resolve_output_dir(&db)?;

    // Get file name for output naming
    let file_name = {
        let conn = db.get_connection();
        let mut stmt = conn
            .prepare("SELECT file_name, ocr_applied FROM files WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        stmt.query_row([file_id], |row| row.get::<_, String>(0))
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
    let output_path = std::path::Path::new(&output_dir).join(format!(
        "{}_{}.{}",
        file_stem,
        &task_id[..8.min(task_id.len())],
        ext
    ));

    std::fs::write(&output_path, &bytes).map_err(|e| format!("Cannot write OCR result: {}", e))?;

    persist_ocr_text_async(app, file_id, bytes.to_vec(), ext == "zip").await?;

    Ok(output_path.to_string_lossy().to_string())
}

/// Synchronous parse via POST /file_parse. Blocks until complete.
/// Returns the saved file path.
#[tauri::command]
pub async fn sync_ocr_parse(
    file_id: i64,
    return_md: Option<bool>,
    response_format_zip: Option<bool>,
    app: AppHandle,
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

    std::fs::write(&output_path, &bytes).map_err(|e| format!("Cannot write OCR result: {}", e))?;

    persist_ocr_text_async(app, file_id, bytes.to_vec(), ext == "zip").await?;

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn get_windows_ocr_status() -> Result<WindowsOcrStatus, String> {
    tokio::task::spawn_blocking(windows_ocr_status)
        .await
        .map_err(|e| format!("Windows OCR status task failed: {e}"))?
}

#[tauri::command]
pub async fn run_windows_ocr(
    file_id: i64,
    task_id: String,
    language: Option<String>,
    app: AppHandle,
    db: State<'_, Database>,
    tasks: State<'_, OcrTaskManager>,
) -> Result<String, String> {
    let registration = tasks.register(&task_id)?;
    let cancellation = registration.cancellation_flag();
    let (file_path, file_name) = get_file_abs_path(&db, file_id)?;
    let output_dir = resolve_output_dir(&db)?;
    let started = Instant::now();
    log::info!(
        "Windows OCR [{}] started: file_id={}, file='{}', language='{}'",
        task_id,
        file_id,
        file_name,
        language.as_deref().unwrap_or("auto")
    );
    let progress_app = app.clone();
    let worker_cancellation = cancellation.clone();
    let task_id_for_worker = task_id.clone();
    let file_name_for_worker = file_name.clone();
    let worker_result = tokio::task::spawn_blocking(move || {
        windows_ocr_pdf(
            &file_path,
            file_id,
            &task_id_for_worker,
            language.as_deref(),
            worker_cancellation,
            |progress| {
                if progress.processed_pages == 1
                    || progress.processed_pages == progress.total_pages
                    || progress.processed_pages % 5 == 0
                {
                    log::info!(
                        "Windows OCR [{}] progress: file='{}', pages={}/{}, {:.0}%",
                        progress.task_id,
                        file_name_for_worker,
                        progress.processed_pages,
                        progress.total_pages,
                        progress.progress
                    );
                }
                let _ = progress_app.emit("ocr:progress", progress);
            },
        )
    })
    .await;
    let markdown = match worker_result {
        Ok(Ok(markdown)) => markdown,
        Ok(Err(error)) => {
            if error == "OCR task cancelled" {
                log::info!("Windows OCR [{}] cancelled", task_id);
            } else {
                log::error!(
                    "Windows OCR [{}] failed for '{}': {}",
                    task_id,
                    file_name,
                    error
                );
            }
            return Err(error);
        }
        Err(error) => {
            let message = format!("Windows OCR task failed: {error}");
            log::error!(
                "Windows OCR [{}] worker failed for '{}': {}",
                task_id,
                file_name,
                error
            );
            return Err(message);
        }
    };
    log::info!(
        "Windows OCR [{}] recognition complete: file='{}', characters={}",
        task_id,
        file_name,
        markdown.chars().count()
    );
    if cancellation.load(Ordering::Acquire) {
        log::info!("Windows OCR [{}] cancelled before saving results", task_id);
        return Err("OCR task cancelled".to_string());
    }

    std::fs::create_dir_all(&output_dir).map_err(|error| {
        let message = format!("Cannot create output directory '{output_dir}': {error}");
        log::error!("Windows OCR [{}] failed: {}", task_id, message);
        message
    })?;
    let file_stem = std::path::Path::new(&file_name)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("file_{file_id}"));
    let suffix = &task_id[..8.min(task_id.len())];
    let output_path =
        std::path::Path::new(&output_dir).join(format!("{file_stem}_{suffix}_windows.md"));
    std::fs::write(&output_path, markdown.as_bytes()).map_err(|error| {
        let message = format!("Cannot write Windows OCR result: {error}");
        log::error!("Windows OCR [{}] failed: {}", task_id, message);
        message
    })?;
    if let Err(error) = persist_ocr_text_async(app, file_id, markdown.into_bytes(), false).await {
        log::error!(
            "Windows OCR [{}] could not update the search index for '{}': {}",
            task_id,
            file_name,
            error
        );
        return Err(error);
    }
    log::info!(
        "Windows OCR [{}] completed: file='{}', output='{}', elapsed_ms={}",
        task_id,
        file_name,
        output_path.display(),
        started.elapsed().as_millis()
    );
    Ok(output_path.to_string_lossy().to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct OcrCandidateRef {
    pub id: i64,
    pub file_name: String,
}

#[tauri::command]
pub fn cancel_ocr_task(task_id: String, tasks: State<'_, OcrTaskManager>) -> Result<bool, String> {
    let cancelled = tasks.cancel(&task_id);
    if cancelled {
        log::info!("OCR task [{}] cancellation requested", task_id);
    }
    Ok(cancelled)
}

#[tauri::command]
pub fn cancel_all_ocr_tasks(tasks: State<'_, OcrTaskManager>) -> Result<usize, String> {
    let cancelled = tasks.cancel_all();
    if cancelled > 0 {
        log::info!("Cancellation requested for {} active OCR tasks", cancelled);
    }
    Ok(cancelled)
}

#[cfg(windows)]
fn windows_ocr_status() -> Result<WindowsOcrStatus, String> {
    use windows::Media::Ocr::OcrEngine;

    let languages = OcrEngine::AvailableRecognizerLanguages()
        .map_err(|e| format!("Cannot query Windows OCR languages: {e}"))?;
    let mut result = Vec::with_capacity(languages.Size().unwrap_or(0) as usize);
    for index in 0..languages.Size().map_err(|e| e.to_string())? {
        let language = languages.GetAt(index).map_err(|e| e.to_string())?;
        result.push(WindowsOcrLanguage {
            tag: language
                .LanguageTag()
                .map_err(|e| e.to_string())?
                .to_string(),
            display_name: language
                .DisplayName()
                .map_err(|e| e.to_string())?
                .to_string(),
            native_name: language
                .NativeName()
                .map_err(|e| e.to_string())?
                .to_string(),
        });
    }
    Ok(WindowsOcrStatus {
        available: !result.is_empty(),
        error: if result.is_empty() {
            Some("No Windows OCR language packs are installed".to_string())
        } else {
            None
        },
        languages: result,
    })
}

#[cfg(not(windows))]
fn windows_ocr_status() -> Result<WindowsOcrStatus, String> {
    Ok(WindowsOcrStatus {
        available: false,
        languages: Vec::new(),
        error: Some("Windows OCR is only available on Windows".to_string()),
    })
}

#[cfg(windows)]
fn windows_ocr_pdf<F>(
    file_path: &str,
    file_id: i64,
    task_id: &str,
    language_tag: Option<&str>,
    cancellation: Arc<std::sync::atomic::AtomicBool>,
    on_progress: F,
) -> Result<String, String>
where
    F: Fn(WindowsOcrProgress),
{
    use windows::core::HSTRING;
    use windows::Data::Pdf::PdfDocument;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    if cancellation.load(Ordering::Acquire) {
        return Err("OCR task cancelled".to_string());
    }

    let ocr_engine = match language_tag.filter(|value| !value.is_empty() && *value != "auto") {
        Some(tag) => {
            let language = Language::CreateLanguage(&HSTRING::from(tag))
                .map_err(|e| format!("Invalid Windows OCR language '{tag}': {e}"))?;
            if !OcrEngine::IsLanguageSupported(&language).map_err(|e| e.to_string())? {
                return Err(format!(
                    "Windows OCR language '{tag}' is not installed. Add its language pack in Windows Settings."
                ));
            }
            OcrEngine::TryCreateFromLanguage(&language)
                .map_err(|e| format!("Cannot create Windows OCR engine for '{tag}': {e}"))?
        }
        None => OcrEngine::TryCreateFromUserProfileLanguages().map_err(|e| {
            format!("Cannot create Windows OCR engine. Install an OCR language pack: {e}")
        })?,
    };

    let file_bytes = std::fs::read(windows_file_system_path(file_path))
        .map_err(|e| format!("Cannot read PDF '{file_path}': {e}"))?;
    let pdf_stream = InMemoryRandomAccessStream::new()
        .map_err(|e| format!("Cannot create PDF input stream: {e}"))?;
    let writer = DataWriter::CreateDataWriter(&pdf_stream)
        .map_err(|e| format!("Cannot create PDF stream writer: {e}"))?;
    for chunk in file_bytes.chunks(16 * 1024 * 1024) {
        writer
            .WriteBytes(chunk)
            .map_err(|e| format!("Cannot buffer PDF data: {e}"))?;
    }
    writer
        .StoreAsync()
        .map_err(|e| format!("Cannot store PDF data in memory: {e}"))?
        .get()
        .map_err(|e| format!("Cannot store PDF data in memory: {e}"))?;
    writer
        .FlushAsync()
        .map_err(|e| format!("Cannot flush PDF data: {e}"))?
        .get()
        .map_err(|e| format!("Cannot flush PDF data: {e}"))?;
    writer
        .DetachStream()
        .map_err(|e| format!("Cannot detach PDF input stream: {e}"))?;
    pdf_stream.Seek(0).map_err(|e| e.to_string())?;
    let document = PdfDocument::LoadFromStreamAsync(&pdf_stream)
        .map_err(|e| format!("Cannot load PDF: {e}"))?
        .get()
        .map_err(|e| format!("Cannot load PDF '{file_path}': {e}"))?;
    let total_pages = document.PageCount().map_err(|e| e.to_string())?;
    if total_pages == 0 {
        return Err("The PDF contains no pages".to_string());
    }

    let mut pages = Vec::with_capacity(total_pages as usize);
    let mut recognized_text = false;
    for page_index in 0..total_pages {
        if cancellation.load(Ordering::Acquire) {
            return Err("OCR task cancelled".to_string());
        }
        let page = document
            .GetPage(page_index)
            .map_err(|e| format!("Cannot open PDF page {}: {e}", page_index + 1))?;
        let stream = InMemoryRandomAccessStream::new()
            .map_err(|e| format!("Cannot create page image stream: {e}"))?;
        page.RenderToStreamAsync(&stream)
            .map_err(|e| format!("Cannot render PDF page {}: {e}", page_index + 1))?
            .get()
            .map_err(|e| format!("Cannot render PDF page {}: {e}", page_index + 1))?;
        stream.Seek(0).map_err(|e| e.to_string())?;
        let decoder = BitmapDecoder::CreateAsync(&stream)
            .map_err(|e| format!("Cannot decode PDF page {}: {e}", page_index + 1))?
            .get()
            .map_err(|e| format!("Cannot decode PDF page {}: {e}", page_index + 1))?;
        let bitmap = decoder
            .GetSoftwareBitmapAsync()
            .map_err(|e| format!("Cannot read PDF page {} bitmap: {e}", page_index + 1))?
            .get()
            .map_err(|e| format!("Cannot read PDF page {} bitmap: {e}", page_index + 1))?;
        let result = ocr_engine
            .RecognizeAsync(&bitmap)
            .map_err(|e| format!("Cannot OCR PDF page {}: {e}", page_index + 1))?
            .get()
            .map_err(|e| format!("Cannot OCR PDF page {}: {e}", page_index + 1))?;
        let text = result.Text().map_err(|e| e.to_string())?.to_string();
        recognized_text |= !text.trim().is_empty();
        pages.push(format!("## Page {}\n\n{}", page_index + 1, text.trim()));
        let processed_pages = page_index + 1;
        on_progress(WindowsOcrProgress {
            task_id: task_id.to_string(),
            file_id,
            processed_pages,
            total_pages,
            progress: processed_pages as f64 * 100.0 / total_pages as f64,
        });
        if cancellation.load(Ordering::Acquire) {
            return Err("OCR task cancelled".to_string());
        }
        let _ = page.Close();
    }

    let markdown = pages.join("\n\n");
    if !recognized_text {
        return Err("Windows OCR did not recognize any text".to_string());
    }
    Ok(markdown)
}

#[cfg(windows)]
fn windows_file_system_path(path: &str) -> std::path::PathBuf {
    let absolute = if std::path::Path::new(path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let normalized = absolute.to_string_lossy().replace('/', "\\");
    if normalized.starts_with(r"\\?\") {
        return normalized.into();
    }
    if let Some(unc) = normalized.strip_prefix(r"\\") {
        format!(r"\\?\UNC\{unc}").into()
    } else {
        format!(r"\\?\{normalized}").into()
    }
}

#[cfg(not(windows))]
fn windows_ocr_pdf<F>(
    _file_path: &str,
    _file_id: i64,
    _task_id: &str,
    _language_tag: Option<&str>,
    _cancellation: Arc<std::sync::atomic::AtomicBool>,
    _on_progress: F,
) -> Result<String, String>
where
    F: Fn(WindowsOcrProgress),
{
    Err("Windows OCR is only available on Windows".to_string())
}

pub(crate) fn persist_ocr_text(
    db: &Database,
    engine: &SearchEngine,
    file_id: i64,
    bytes: &[u8],
    is_zip: bool,
) -> Result<(), String> {
    let text = if is_zip {
        markdown_from_zip(bytes)?
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    let text = normalize_cjk_ocr_spacing(&text);
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

pub(crate) async fn persist_ocr_text_async(
    app: AppHandle,
    file_id: i64,
    bytes: Vec<u8>,
    is_zip: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let db = app.state::<Database>();
        let engine = app.state::<SearchEngine>();
        persist_ocr_text(&db, &engine, file_id, &bytes, is_zip)
    })
    .await
    .map_err(|error| format!("OCR result indexing task failed: {error}"))?
}

fn markdown_from_zip(bytes: &[u8]) -> Result<String, String> {
    let cursor = Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid OCR ZIP result: {}", e))?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|e| e.to_string())?;
        if file.name().to_ascii_lowercase().ends_with(".md") {
            let mut text = String::new();
            file.read_to_string(&mut text)
                .map_err(|e| format!("Cannot read Markdown from OCR ZIP: {}", e))?;
            return Ok(text);
        }
    }
    Err("OCR ZIP result contains no Markdown file".to_string())
}

#[cfg(test)]
mod tests {
    use super::{markdown_from_zip, persist_ocr_text, resolve_output_dir};
    use crate::db::Database;
    use crate::search::SearchEngine;
    use std::io::{Cursor, Write};
    use std::path::PathBuf;

    #[test]
    fn extracts_markdown_from_zip_result() {
        let mut output = Cursor::new(Vec::new());
        {
            let mut archive = zip::ZipWriter::new(&mut output);
            archive
                .start_file(
                    "result/document.md",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            archive
                .write_all("# OCR result\nneedle".as_bytes())
                .unwrap();
            archive.finish().unwrap();
        }
        assert!(markdown_from_zip(output.get_ref())
            .unwrap()
            .contains("needle"));
    }

    #[test]
    fn rejects_invalid_zip_results_and_archives_without_markdown() {
        assert!(markdown_from_zip(b"not a zip")
            .unwrap_err()
            .contains("Invalid OCR ZIP"));

        let mut output = Cursor::new(Vec::new());
        {
            let mut archive = zip::ZipWriter::new(&mut output);
            archive
                .start_file("result.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(b"plain text").unwrap();
            archive.finish().unwrap();
        }
        assert!(markdown_from_zip(output.get_ref())
            .unwrap_err()
            .contains("no Markdown file"));
    }

    #[test]
    fn default_ocr_output_is_stored_beside_the_application_database() {
        let root =
            std::env::temp_dir().join(format!("xdocuments-ocr-output-{}", uuid::Uuid::new_v4()));
        let database = Database::new(&root).unwrap();
        assert_eq!(
            PathBuf::from(resolve_output_dir(&database).unwrap()),
            root.join("OCR_result")
        );
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn persisted_ocr_text_updates_the_database_and_embedded_search() {
        let root =
            std::env::temp_dir().join(format!("xdocuments-ocr-persist-{}", uuid::Uuid::new_v4()));
        let database = Database::new(&root).unwrap();
        {
            let conn = database.get_connection();
            conn.execute(
                "INSERT INTO watched_folders (id, path, display_name) VALUES (1, 'C:/documents', 'Test')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO files (id, folder_id, relative_path, file_name, file_size_bytes, content_hash, file_modified_at, index_status) VALUES (7, 1, 'source.pdf', 'source.pdf', 100, 'hash', '2026-01-01T00:00:00', 'indexed')",
                [],
            )
            .unwrap();
        }
        let engine = SearchEngine::open(&root.join("tantivy")).unwrap();

        persist_ocr_text(
            &database,
            &engine,
            7,
            b"# OCR\nunique-embedded-ocr-token",
            false,
        )
        .unwrap();

        let (applied, text): (i64, String) = database
            .get_connection()
            .query_row(
                "SELECT ocr_applied, text_preview FROM files WHERE id = 7",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(applied, 1);
        assert!(text.contains("unique-embedded-ocr-token"));
        assert_eq!(
            engine
                .search("unique-embedded-ocr-token", None, 10)
                .unwrap()[0]
                .file_id,
            7
        );

        drop(engine);
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn detects_installed_windows_ocr_languages() {
        let status = super::windows_ocr_status().unwrap();
        assert!(status.available, "{:?}", status.error);
        assert!(!status.languages.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn cancels_windows_ocr_before_opening_the_pdf() {
        let result = super::windows_ocr_pdf(
            "missing.pdf",
            1,
            "cancelled-task",
            None,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            |_| {},
        );
        assert_eq!(result.unwrap_err(), "OCR task cancelled");
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires XDOCUMENTS_WINDOWS_OCR_PDF to point to a real PDF"]
    fn recognizes_a_real_pdf_with_windows_ocr() {
        let path = std::env::var("XDOCUMENTS_WINDOWS_OCR_PDF")
            .expect("XDOCUMENTS_WINDOWS_OCR_PDF must point to a real PDF");
        let markdown = super::windows_ocr_pdf(
            &path,
            1,
            "windows-ocr-test",
            Some("zh-Hans-CN"),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        assert!(markdown.contains("## Page 1"));
        assert!(markdown.chars().count() > 20);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires XDOCUMENTS_WINDOWS_OCR_PDF to point to a real PDF"]
    fn recognizes_a_real_pdf_from_a_long_path() {
        let source = std::env::var("XDOCUMENTS_WINDOWS_OCR_PDF")
            .expect("XDOCUMENTS_WINDOWS_OCR_PDF must point to a real PDF");
        let root =
            std::env::temp_dir().join(format!("xdocuments-long-path-{}", uuid::Uuid::new_v4()));
        let long_dir = (0..6).fold(root.clone(), |path, index| {
            path.join(format!(
                "ocr-long-path-segment-{index}-abcdefghijklmnopqrstuvwxyz0123456789"
            ))
        });
        let destination = long_dir.join("windows-ocr-long-path-test.pdf");
        std::fs::create_dir_all(super::windows_file_system_path(&long_dir.to_string_lossy()))
            .unwrap();
        std::fs::copy(
            super::windows_file_system_path(&source),
            super::windows_file_system_path(&destination.to_string_lossy()),
        )
        .unwrap();
        assert!(destination.to_string_lossy().chars().count() > 260);

        let markdown = super::windows_ocr_pdf(
            &destination.to_string_lossy(),
            1,
            "windows-ocr-long-path-test",
            Some("zh-Hans-CN"),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        assert!(markdown.contains("## Page 1"));
        assert!(markdown.chars().count() > 20);

        let _ = std::fs::remove_dir_all(super::windows_file_system_path(&root.to_string_lossy()));
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
            "# OCR\nunique-elastic-ocr-token 供 应 商 审 计 中 国 科 学 院".as_bytes(),
            false,
        )
        .unwrap();

        assert_eq!(engine.backend_status().backend, "elasticsearch");
        assert_eq!(
            engine.search("unique-elastic-ocr-token", None, 10).unwrap()[0].file_id,
            41
        );
        assert_eq!(
            engine.search("供应商审计", None, 10).unwrap()[0].file_id,
            41
        );
        assert_eq!(engine.search("中国", None, 10).unwrap()[0].file_id, 41);
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
    pending_only: Option<bool>,
    db: State<'_, Database>,
) -> Result<PaginatedResult<crate::models::FileInfo>, String> {
    let conn = db.get_connection();
    let page = page.max(0);
    let page_size = page_size.clamp(1, 500);
    let pending_only = pending_only.unwrap_or(true);

    // Build WHERE clause shared by COUNT and data queries
    let where_clause = "index_status = 'indexed' AND (?1 IS NULL OR folder_id = ?1) AND (?2 = 0 OR ocr_applied = 0)";

    // Get total count
    let count_sql = format!("SELECT COUNT(*) FROM files WHERE {}", where_clause);
    let total: i64 = conn
        .query_row(
            &count_sql,
            rusqlite::params![folder_id, pending_only],
            |row| row.get(0),
        )
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
         LIMIT ?3 OFFSET ?4",
        where_clause
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params![folder_id, pending_only, page_size, offset],
            crate::db::row_to_file_info,
        )
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

#[tauri::command]
pub fn list_ocr_candidate_refs(
    folder_id: Option<i64>,
    after_id: Option<i64>,
    limit: Option<i64>,
    db: State<'_, Database>,
) -> Result<Vec<OcrCandidateRef>, String> {
    let conn = db.get_connection();
    list_ocr_candidate_refs_from_connection(&conn, folder_id, after_id, limit)
}

fn list_ocr_candidate_refs_from_connection(
    conn: &rusqlite::Connection,
    folder_id: Option<i64>,
    after_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<OcrCandidateRef>, String> {
    let after_id = after_id.unwrap_or(0).max(0);
    let limit = limit.unwrap_or(500).clamp(1, 5_000);
    let mut statement = conn
        .prepare(
            "SELECT id, file_name FROM files \
             WHERE (?1 IS NULL OR folder_id = ?1) AND index_status = 'indexed' \
               AND ocr_applied = 0 AND id > ?2 \
             ORDER BY id LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(rusqlite::params![folder_id, after_id, limit], |row| {
            Ok(OcrCandidateRef {
                id: row.get(0)?,
                file_name: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod incremental_ocr_tests {
    use super::list_ocr_candidate_refs_from_connection;
    use crate::db::schema;
    use rusqlite::Connection;

    #[test]
    fn cursor_query_returns_only_pending_ocr_files() {
        let conn = Connection::open_in_memory().unwrap();
        schema::run_migrations(&conn).unwrap();
        conn.execute(
            "INSERT INTO watched_folders (id, path) VALUES (1, 'C:/documents')",
            [],
        )
        .unwrap();
        for (id, applied) in [(1, 0), (2, 1), (3, 0), (4, 0)] {
            conn.execute(
                "INSERT INTO files (
                    id, folder_id, relative_path, file_name, file_size_bytes,
                    content_hash, file_modified_at, index_status, ocr_applied
                 ) VALUES (?1, 1, ?2, ?2, 10, 'hash', '2026-01-01', 'indexed', ?3)",
                rusqlite::params![id, format!("{id}.pdf"), applied],
            )
            .unwrap();
        }

        let first = list_ocr_candidate_refs_from_connection(&conn, Some(1), None, Some(2)).unwrap();
        assert_eq!(
            first.iter().map(|item| item.id).collect::<Vec<_>>(),
            vec![1, 3]
        );
        let second =
            list_ocr_candidate_refs_from_connection(&conn, Some(1), Some(3), Some(2)).unwrap();
        assert_eq!(
            second.iter().map(|item| item.id).collect::<Vec<_>>(),
            vec![4]
        );
    }

    #[test]
    fn cursor_query_streams_more_than_one_hundred_candidates_across_folders() {
        let conn = Connection::open_in_memory().unwrap();
        schema::run_migrations(&conn).unwrap();
        conn.execute(
            "INSERT INTO watched_folders (id, path) VALUES (1, 'C:/one'), (2, 'C:/two')",
            [],
        )
        .unwrap();
        for id in 1..=205 {
            conn.execute(
                "INSERT INTO files (
                    id, folder_id, relative_path, file_name, file_size_bytes,
                    content_hash, file_modified_at, index_status, ocr_applied
                 ) VALUES (?1, ?2, ?3, ?3, 10, 'hash', '2026-01-01', 'indexed', 0)",
                rusqlite::params![id, if id % 2 == 0 { 1 } else { 2 }, format!("{id}.pdf")],
            )
            .unwrap();
        }

        let mut after_id = None;
        let mut ids = Vec::new();
        loop {
            let batch =
                list_ocr_candidate_refs_from_connection(&conn, None, after_id, Some(100)).unwrap();
            if batch.is_empty() {
                break;
            }
            after_id = batch.last().map(|item| item.id);
            ids.extend(batch.into_iter().map(|item| item.id));
        }

        assert_eq!(ids.len(), 205);
        assert_eq!(ids.first(), Some(&1));
        assert_eq!(ids.last(), Some(&205));
    }
}
