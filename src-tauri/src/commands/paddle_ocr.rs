use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::ocr::{
    get_file_abs_path, persist_ocr_text_async, resolve_output_dir, WindowsOcrProgress,
};
use crate::commands::ocr_control::OcrTaskManager;
use crate::db::Database;
use crate::paddle_runtime::{self, RuntimePaths};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaddleOcrStatus {
    pub available: bool,
    pub python_path: String,
    pub managed: bool,
    pub install_supported: bool,
    pub install_required: bool,
    pub runtime_version: Option<String>,
    pub paddle_version: Option<String>,
    pub paddleocr_version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WorkerMessage {
    #[serde(rename = "type")]
    kind: Option<String>,
    processed_pages: Option<u32>,
    total_pages: Option<u32>,
    progress: Option<f64>,
    error: Option<String>,
}

#[tauri::command]
pub async fn get_paddle_ocr_status(
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<PaddleOcrStatus, String> {
    let paths = RuntimePaths::for_app(&app)?;
    let (python_path, managed) = match resolve_python(&paths, &db) {
        Some(runtime) => runtime,
        None => {
            return Ok(unavailable_status(
                &paths.python,
                true,
                "PaddleOCR is not installed. Install the managed runtime to continue.",
            ));
        }
    };
    let script = worker_script(&app)?;
    tokio::task::spawn_blocking(move || check_environment(&python_path, &script, &paths, managed))
        .await
        .map_err(|error| format!("PaddleOCR status task failed: {error}"))?
}

#[tauri::command]
pub async fn install_paddle_ocr(
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<PaddleOcrStatus, String> {
    let requirements = requirements_path(&app)?;
    let constraints = constraints_path(&app)?;
    let script = worker_script(&app)?;
    let app_for_install = app.clone();
    log::info!("PaddleOCR managed runtime installation started");
    let status = tokio::task::spawn_blocking(move || -> Result<PaddleOcrStatus, String> {
        let paths =
            paddle_runtime::install_managed_runtime(&app_for_install, &requirements, &constraints)?;
        check_environment(&paths.python, &script, &paths, true)
    })
    .await
    .map_err(|error| format!("PaddleOCR installer task failed: {error}"))??;
    set_setting(&db, "paddle_python_path", "")?;
    log::info!("PaddleOCR managed runtime installation completed");
    Ok(status)
}

#[tauri::command]
pub async fn run_paddle_ocr(
    file_id: i64,
    task_id: String,
    language: Option<String>,
    model: Option<String>,
    app: AppHandle,
    db: State<'_, Database>,
    tasks: State<'_, OcrTaskManager>,
) -> Result<String, String> {
    let runtime_paths = RuntimePaths::for_app(&app)?;
    let (python_path, _) = resolve_python(&runtime_paths, &db).ok_or_else(|| {
        "PaddleOCR is not installed. Install the managed runtime before starting OCR.".to_string()
    })?;
    let registration = tasks.register(&task_id)?;
    let cancellation = registration.cancellation_flag();
    let (file_path, file_name) = get_file_abs_path(&db, file_id)?;
    let output_dir = resolve_output_dir(&db)?;
    std::fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
    let suffix = &task_id[..8.min(task_id.len())];
    let file_stem = Path::new(&file_name)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("file_{file_id}"));
    let output_path = Path::new(&output_dir).join(format!("{file_stem}_{suffix}_paddle.md"));
    let script = worker_script(&app)?;
    let language = language.unwrap_or_else(|| "ch".to_string());
    let model = model.unwrap_or_else(|| "PP-OCRv5_mobile".to_string());
    let started = Instant::now();
    log::info!(
        "PaddleOCR [{}] started: file_id={}, file='{}', language='{}', model='{}'",
        task_id,
        file_id,
        file_name,
        language,
        model
    );

    let app_for_worker = app.clone();
    let worker_cancellation = cancellation.clone();
    let task_for_worker = task_id.clone();
    let file_for_worker = file_name.clone();
    let output_for_worker = output_path.clone();
    let worker_result = tokio::task::spawn_blocking(move || {
        run_worker(
            &python_path,
            &runtime_paths,
            &script,
            &file_path,
            &output_for_worker,
            &language,
            &model,
            file_id,
            &task_for_worker,
            &file_for_worker,
            &app_for_worker,
            worker_cancellation,
        )
    })
    .await
    .map_err(|error| format!("PaddleOCR worker task failed: {error}"))?;

    if let Err(error) = worker_result {
        if error == "OCR task cancelled" {
            log::info!("PaddleOCR [{}] cancelled", task_id);
        } else {
            log::error!("PaddleOCR [{}] failed: {}", task_id, error);
        }
        return Err(error);
    }
    if cancellation.load(Ordering::Acquire) {
        log::info!("PaddleOCR [{}] cancelled before saving results", task_id);
        return Err("OCR task cancelled".to_string());
    }
    let markdown = std::fs::read(&output_path)
        .map_err(|error| format!("Cannot read PaddleOCR result: {error}"))?;
    persist_ocr_text_async(app, file_id, markdown, false).await?;
    log::info!(
        "PaddleOCR [{}] completed: file='{}', output='{}', elapsed_ms={}",
        task_id,
        file_name,
        output_path.display(),
        started.elapsed().as_millis()
    );
    Ok(output_path.to_string_lossy().to_string())
}

fn run_worker(
    python: &Path,
    runtime_paths: &RuntimePaths,
    script: &Path,
    input: &str,
    output: &Path,
    language: &str,
    model: &str,
    file_id: i64,
    task_id: &str,
    file_name: &str,
    app: &AppHandle,
    cancellation: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    let mut command = hidden_command(python);
    paddle_runtime::configure_python_command(&mut command, runtime_paths);
    let mut child = command
        .arg(script)
        .args(["--input", input, "--language", language, "--model", model])
        .arg("--output")
        .arg(output)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            format!(
                "Cannot start PaddleOCR worker with '{}': {error}",
                python.display()
            )
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "PaddleOCR stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "PaddleOCR stderr unavailable".to_string())?;
    let (sender, receiver) = mpsc::channel();
    let stdout_thread = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = sender.send(line);
        }
    });
    let stderr_text = Arc::new(Mutex::new(String::new()));
    let stderr_target = stderr_text.clone();
    let stderr_thread = std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_string(&mut stderr_target.lock().unwrap());
    });
    let mut worker_error = None;
    let status = loop {
        while let Ok(line) = receiver.try_recv() {
            handle_worker_line(&line, file_id, task_id, file_name, app, &mut worker_error);
        }
        if cancellation.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
            return Err("OCR task cancelled".to_string());
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(75));
    };
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    while let Ok(line) = receiver.try_recv() {
        handle_worker_line(&line, file_id, task_id, file_name, app, &mut worker_error);
    }
    if !status.success() {
        let stderr = stderr_text.lock().unwrap();
        return Err(worker_error.unwrap_or_else(|| {
            format!(
                "PaddleOCR worker exited with {status}: {}",
                tail(&stderr, 4_000)
            )
        }));
    }
    Ok(())
}

fn handle_worker_line(
    line: &str,
    file_id: i64,
    task_id: &str,
    file_name: &str,
    app: &AppHandle,
    worker_error: &mut Option<String>,
) {
    let Ok(message) = serde_json::from_str::<WorkerMessage>(line) else {
        log::debug!("PaddleOCR [{}]: {}", task_id, line);
        return;
    };
    if message.kind.as_deref() == Some("error") {
        *worker_error = message.error;
        return;
    }
    let (Some(processed_pages), Some(total_pages), Some(progress)) = (
        message.processed_pages,
        message.total_pages,
        message.progress,
    ) else {
        return;
    };
    log::info!(
        "PaddleOCR [{}] progress: file='{}', pages={}/{}, {:.0}%",
        task_id,
        file_name,
        processed_pages,
        total_pages,
        progress
    );
    let _ = app.emit(
        "ocr:progress",
        WindowsOcrProgress {
            task_id: task_id.to_string(),
            file_id,
            processed_pages,
            total_pages,
            progress,
        },
    );
}

fn check_environment(
    python: &Path,
    script: &Path,
    runtime_paths: &RuntimePaths,
    managed: bool,
) -> Result<PaddleOcrStatus, String> {
    let mut command = hidden_command(python);
    paddle_runtime::configure_python_command(&mut command, runtime_paths);
    let output = command
        .arg(script)
        .arg("--check")
        .output()
        .map_err(|error| {
            format!(
                "Cannot start PaddleOCR runtime '{}': {error}",
                python.display()
            )
        })?;
    let value = String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<serde_json::Value>(line).ok());
    let available = output.status.success()
        && value
            .as_ref()
            .and_then(|value| value.get("available"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
    Ok(PaddleOcrStatus {
        available,
        python_path: python.to_string_lossy().to_string(),
        managed,
        install_supported: paddle_runtime::install_supported(),
        install_required: !available,
        runtime_version: managed.then(|| paddle_runtime::RUNTIME_VERSION.to_string()),
        paddle_version: value
            .as_ref()
            .and_then(|value| value.get("paddle_version"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        paddleocr_version: value
            .as_ref()
            .and_then(|value| value.get("paddleocr_version"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        error: if available {
            None
        } else {
            Some(
                value
                    .as_ref()
                    .and_then(|value| value.get("error"))
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| tail(&String::from_utf8_lossy(&output.stderr), 2_000)),
            )
        },
    })
}

fn resolve_python(paths: &RuntimePaths, db: &Database) -> Option<(PathBuf, bool)> {
    if paths.is_ready() {
        return Some((paths.python.clone(), true));
    }
    let configured = setting(db, "paddle_python_path", "");
    let configured = configured.trim();
    if !configured.is_empty() && !configured.eq_ignore_ascii_case("python") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some((path, false));
        }
    }
    None
}

fn unavailable_status(path: &Path, managed: bool, error: &str) -> PaddleOcrStatus {
    PaddleOcrStatus {
        available: false,
        python_path: path.to_string_lossy().to_string(),
        managed,
        install_supported: paddle_runtime::install_supported(),
        install_required: true,
        runtime_version: managed.then(|| paddle_runtime::RUNTIME_VERSION.to_string()),
        paddle_version: None,
        paddleocr_version: None,
        error: Some(if paddle_runtime::install_supported() {
            error.to_string()
        } else {
            paddle_runtime::unsupported_message()
        }),
    }
}

fn worker_script(app: &AppHandle) -> Result<PathBuf, String> {
    resource_file(app, "paddle_ocr_worker.py")
}

fn requirements_path(app: &AppHandle) -> Result<PathBuf, String> {
    resource_file(app, "paddleocr-requirements.txt")
}

fn constraints_path(app: &AppHandle) -> Result<PathBuf, String> {
    resource_file(app, "paddleocr-constraints.txt")
}

fn resource_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("scripts").join(name));
        candidates.push(resource_dir.join(name));
    }
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("scripts")
            .join(name),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("PaddleOCR resource '{name}' was not found"))
}

fn setting(db: &Database, key: &str, default: &str) -> String {
    let conn = db.get_connection();
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .unwrap_or_else(|_| default.to_string())
}

fn set_setting(db: &Database, key: &str, value: &str) -> Result<(), String> {
    let conn = db.get_connection();
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        rusqlite::params![key, value],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = command;
        command.creation_flags(0x08000000);
        command
    }
    #[cfg(not(windows))]
    command
}

fn tail(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .rev()
        .take(max_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{tail, worker_script};

    #[test]
    fn keeps_only_requested_error_tail() {
        assert_eq!(tail("abcdef", 3), "def");
    }

    #[test]
    fn development_worker_script_exists() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("scripts")
            .join("paddle_ocr_worker.py");
        assert!(path.is_file());
        let _ = worker_script;
    }
}
