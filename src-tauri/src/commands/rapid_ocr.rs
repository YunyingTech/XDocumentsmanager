use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
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
use crate::paddle_runtime::{self, RapidRuntimeProfile, RuntimePaths};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RapidOcrStatus {
    pub available: bool,
    pub python_path: String,
    pub managed: bool,
    pub install_supported: bool,
    pub install_required: bool,
    pub runtime_version: Option<String>,
    pub rapidocr_version: Option<String>,
    pub onnxruntime_version: Option<String>,
    pub pymupdf_version: Option<String>,
    pub requested_device_mode: String,
    pub requested_provider: Option<String>,
    pub active_provider: Option<String>,
    pub accelerated: bool,
    pub available_providers: Vec<String>,
    pub session_providers: Vec<Vec<String>>,
    pub runtime_profile: Option<String>,
    pub fallback_reason: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RapidDeviceMode {
    Auto,
    Cpu,
}

impl RapidDeviceMode {
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "cpu" => Self::Cpu,
            _ => Self::Auto,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
struct WorkerEnvironment {
    available: bool,
    rapidocr_version: Option<String>,
    onnxruntime_version: Option<String>,
    pymupdf_version: Option<String>,
    requested_provider: Option<String>,
    active_provider: Option<String>,
    #[serde(default)]
    accelerated: bool,
    #[serde(default)]
    available_providers: Vec<String>,
    #[serde(default)]
    session_providers: Vec<Vec<String>>,
    fallback_reason: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WorkerMessage {
    #[serde(rename = "type")]
    kind: Option<String>,
    task_id: Option<String>,
    processed_pages: Option<u32>,
    total_pages: Option<u32>,
    progress: Option<f64>,
    requested_provider: Option<String>,
    active_provider: Option<String>,
    accelerated: Option<bool>,
    fallback_reason: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
pub struct RapidOcrWorkerPool {
    idle: Mutex<Vec<PersistentWorker>>,
}

struct PersistentWorker {
    child: Child,
    stdin: ChildStdin,
    output: mpsc::Receiver<String>,
    stderr: Arc<Mutex<String>>,
}

#[tauri::command]
pub async fn get_rapid_ocr_status(
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<RapidOcrStatus, String> {
    let mode = RapidDeviceMode::parse(&setting(&db, "rapidocr_device_mode", "auto"));
    let profile = match paddle_runtime::rapid_runtime_profile() {
        Ok(profile) => profile,
        Err(error) => return Ok(unsupported_status(mode, error)),
    };
    let paths = RuntimePaths::for_rapid_app(&app, profile)?;
    let requirements = requirements_path(&app, profile)?;
    let constraints = constraints_path(&app)?;
    let wheelhouse =
        paddle_runtime::embedded_rapid_wheelhouse(&app, profile, &requirements, &constraints)?;
    let script = worker_script(&app)?;
    let app_for_install = app.clone();
    tokio::task::spawn_blocking(move || {
        let paths = ensure_embedded_runtime(
            &app_for_install,
            profile,
            paths,
            &requirements,
            &constraints,
            &wheelhouse,
        )?;
        resolve_status(mode, profile, paths, &script)
    })
    .await
    .map_err(|error| format!("RapidOCR status task failed: {error}"))?
}

#[tauri::command]
pub async fn install_rapid_ocr(
    device_mode: Option<String>,
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<RapidOcrStatus, String> {
    let mode = RapidDeviceMode::parse(
        &device_mode.unwrap_or_else(|| setting(&db, "rapidocr_device_mode", "auto")),
    );
    let profile = paddle_runtime::rapid_runtime_profile()?;
    let requirements = requirements_path(&app, profile)?;
    let constraints = constraints_path(&app)?;
    let wheelhouse =
        paddle_runtime::embedded_rapid_wheelhouse(&app, profile, &requirements, &constraints)?;
    let script = worker_script(&app)?;
    let paths = RuntimePaths::for_rapid_app(&app, profile)?;
    let app_for_install = app.clone();
    log::info!(
        "RapidOCR embedded runtime installation started: profile={}, source='{}'",
        profile.as_str(),
        wheelhouse.display()
    );
    let status = tokio::task::spawn_blocking(move || -> Result<RapidOcrStatus, String> {
        paddle_runtime::install_managed_rapid_runtime(
            &app_for_install,
            profile,
            &requirements,
            &constraints,
            &wheelhouse,
        )?;
        resolve_status(mode, profile, paths, &script)
    })
    .await
    .map_err(|error| format!("RapidOCR installer task failed: {error}"))??;
    log::info!(
        "RapidOCR embedded runtime installation completed: profile={}, provider={}",
        profile.as_str(),
        status.active_provider.as_deref().unwrap_or("unavailable")
    );
    Ok(status)
}

#[tauri::command]
pub async fn run_rapid_ocr(
    file_id: i64,
    task_id: String,
    language: Option<String>,
    model: Option<String>,
    app: AppHandle,
    db: State<'_, Database>,
    tasks: State<'_, OcrTaskManager>,
) -> Result<String, String> {
    let mode = RapidDeviceMode::parse(&setting(&db, "rapidocr_device_mode", "auto"));
    let profile = paddle_runtime::rapid_runtime_profile()?;
    let runtime_paths = RuntimePaths::for_rapid_app(&app, profile)?;
    let requirements = requirements_path(&app, profile)?;
    let constraints = constraints_path(&app)?;
    let wheelhouse =
        paddle_runtime::embedded_rapid_wheelhouse(&app, profile, &requirements, &constraints)?;
    let script = worker_script(&app)?;
    let app_for_install = app.clone();
    let runtime_paths = tokio::task::spawn_blocking(move || {
        ensure_embedded_runtime(
            &app_for_install,
            profile,
            runtime_paths,
            &requirements,
            &constraints,
            &wheelhouse,
        )
    })
    .await
    .map_err(|error| format!("RapidOCR runtime provisioning task failed: {error}"))??;

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
    let output_path = Path::new(&output_dir).join(format!("{file_stem}_{suffix}_rapid.md"));
    let language = language.unwrap_or_else(|| "ch".to_string());
    let model = model.unwrap_or_else(|| "PP-OCRv6_small".to_string());
    let started = Instant::now();
    log::info!(
        "RapidOCR [{}] started: file_id={}, file='{}', language='{}', model='{}', device_mode='{}'",
        task_id,
        file_id,
        file_name,
        language,
        model,
        mode.as_str()
    );

    let python_path = runtime_paths.python.clone();
    let app_for_worker = app.clone();
    let worker_cancellation = cancellation.clone();
    let task_for_worker = task_id.clone();
    let file_for_worker = file_name.clone();
    let output_for_worker = output_path.clone();
    let worker_result = tokio::task::spawn_blocking(move || {
        let pool = app_for_worker.state::<RapidOcrWorkerPool>();
        run_worker(
            &pool,
            &python_path,
            &runtime_paths,
            &script,
            &file_path,
            &output_for_worker,
            &language,
            &model,
            mode,
            file_id,
            &task_for_worker,
            &file_for_worker,
            &app_for_worker,
            worker_cancellation,
        )
    })
    .await
    .map_err(|error| format!("RapidOCR worker task failed: {error}"))?;

    if let Err(error) = worker_result {
        if error == "OCR task cancelled" {
            log::info!("RapidOCR [{}] cancelled", task_id);
        } else {
            log::error!("RapidOCR [{}] failed: {}", task_id, error);
        }
        return Err(error);
    }
    if cancellation.load(Ordering::Acquire) {
        log::info!("RapidOCR [{}] cancelled before saving results", task_id);
        return Err("OCR task cancelled".to_string());
    }
    let markdown = std::fs::read(&output_path)
        .map_err(|error| format!("Cannot read RapidOCR result: {error}"))?;
    persist_ocr_text_async(app, file_id, markdown, false).await?;
    log::info!(
        "RapidOCR [{}] completed: file='{}', output='{}', elapsed_ms={}",
        task_id,
        file_name,
        output_path.display(),
        started.elapsed().as_millis()
    );
    Ok(output_path.to_string_lossy().to_string())
}

#[allow(clippy::too_many_arguments)]
fn run_worker(
    pool: &RapidOcrWorkerPool,
    python: &Path,
    runtime_paths: &RuntimePaths,
    script: &Path,
    input: &str,
    output: &Path,
    language: &str,
    model: &str,
    mode: RapidDeviceMode,
    file_id: i64,
    task_id: &str,
    file_name: &str,
    app: &AppHandle,
    cancellation: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    pool.execute(
        python,
        runtime_paths,
        script,
        input,
        output,
        language,
        model,
        mode,
        file_id,
        task_id,
        file_name,
        app,
        cancellation,
    )
}

impl RapidOcrWorkerPool {
    #[allow(clippy::too_many_arguments)]
    fn execute(
        &self,
        python: &Path,
        runtime_paths: &RuntimePaths,
        script: &Path,
        input: &str,
        output: &Path,
        language: &str,
        model: &str,
        mode: RapidDeviceMode,
        file_id: i64,
        task_id: &str,
        file_name: &str,
        app: &AppHandle,
        cancellation: Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<(), String> {
        let mut worker = self
            .idle
            .lock()
            .map_err(|error| error.to_string())?
            .pop()
            .map(Ok)
            .unwrap_or_else(|| PersistentWorker::spawn(python, runtime_paths, script))?;
        if let Ok(mut stderr) = worker.stderr.lock() {
            stderr.clear();
        }
        let result = worker.run(
            input,
            output,
            language,
            model,
            mode,
            file_id,
            task_id,
            file_name,
            app,
            cancellation,
        );
        let reusable = worker.child.try_wait().is_ok_and(|status| status.is_none());
        if reusable {
            self.idle
                .lock()
                .map_err(|error| error.to_string())?
                .push(worker);
        }
        result
    }
}

impl PersistentWorker {
    fn spawn(python: &Path, runtime_paths: &RuntimePaths, script: &Path) -> Result<Self, String> {
        let mut command = hidden_command(python);
        paddle_runtime::configure_python_command(&mut command, runtime_paths);
        let mut child = command
            .arg(script)
            .arg("--server")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                format!(
                    "Cannot start RapidOCR worker with '{}': {error}",
                    python.display()
                )
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "RapidOCR stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "RapidOCR stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "RapidOCR stderr unavailable".to_string())?;
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = sender.send(line);
            }
        });
        let stderr_text = Arc::new(Mutex::new(String::new()));
        let stderr_target = stderr_text.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut value) = stderr_target.lock() {
                    value.push_str(&line);
                    value.push('\n');
                    if value.len() > 8_000 {
                        let split = value
                            .char_indices()
                            .nth(value.chars().count().saturating_sub(4_000))
                            .map(|(index, _)| index)
                            .unwrap_or(0);
                        value.drain(..split);
                    }
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            output: receiver,
            stderr: stderr_text,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        &mut self,
        input: &str,
        output: &Path,
        language: &str,
        model: &str,
        mode: RapidDeviceMode,
        file_id: i64,
        task_id: &str,
        file_name: &str,
        app: &AppHandle,
        cancellation: Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<(), String> {
        let request = serde_json::json!({
            "task_id": task_id,
            "input": input,
            "output": output,
            "language": language,
            "model": model,
            "device": mode.as_str(),
        });
        serde_json::to_writer(&mut self.stdin, &request).map_err(|error| error.to_string())?;
        self.stdin
            .write_all(b"\n")
            .map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())?;

        loop {
            if cancellation.load(Ordering::Acquire) {
                let _ = self.child.kill();
                let _ = self.child.wait();
                return Err("OCR task cancelled".to_string());
            }
            match self.output.recv_timeout(Duration::from_millis(75)) {
                Ok(line) => match handle_worker_line(&line, file_id, task_id, file_name, app) {
                    WorkerLineResult::Continue => {}
                    WorkerLineResult::Complete => return Ok(()),
                    WorkerLineResult::Error(error) => return Err(error),
                },
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(status) =
                        self.child.try_wait().map_err(|error| error.to_string())?
                    {
                        return Err(format!(
                            "RapidOCR worker exited with {status}: {}",
                            self.stderr_tail()
                        ));
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(format!(
                        "RapidOCR worker output closed unexpectedly: {}",
                        self.stderr_tail()
                    ));
                }
            }
        }
    }

    fn stderr_tail(&self) -> String {
        self.stderr
            .lock()
            .map(|value| tail(&value, 4_000))
            .unwrap_or_default()
    }
}

impl Drop for PersistentWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

enum WorkerLineResult {
    Continue,
    Complete,
    Error(String),
}

fn handle_worker_line(
    line: &str,
    file_id: i64,
    task_id: &str,
    file_name: &str,
    app: &AppHandle,
) -> WorkerLineResult {
    let Ok(message) = serde_json::from_str::<WorkerMessage>(line) else {
        log::debug!("RapidOCR [{}]: {}", task_id, line);
        return WorkerLineResult::Continue;
    };
    if message
        .task_id
        .as_deref()
        .is_some_and(|value| value != task_id)
    {
        log::warn!("RapidOCR [{}] ignored output for another task", task_id);
        return WorkerLineResult::Continue;
    }
    match message.kind.as_deref() {
        Some("error") => WorkerLineResult::Error(
            message
                .error
                .unwrap_or_else(|| "RapidOCR worker failed".to_string()),
        ),
        Some("complete") => WorkerLineResult::Complete,
        Some("runtime") => {
            log::info!(
                "RapidOCR [{}] runtime: requested='{}', active='{}', accelerated={}",
                task_id,
                message.requested_provider.as_deref().unwrap_or("unknown"),
                message.active_provider.as_deref().unwrap_or("unknown"),
                message.accelerated.unwrap_or(false)
            );
            if let Some(reason) = message.fallback_reason {
                log::warn!("RapidOCR [{}] runtime fallback: {}", task_id, reason);
            }
            WorkerLineResult::Continue
        }
        Some("progress") => {
            let (Some(processed_pages), Some(total_pages), Some(progress)) = (
                message.processed_pages,
                message.total_pages,
                message.progress,
            ) else {
                return WorkerLineResult::Continue;
            };
            log::info!(
                "RapidOCR [{}] progress: file='{}', pages={}/{}, {:.0}%",
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
            WorkerLineResult::Continue
        }
        _ => WorkerLineResult::Continue,
    }
}

fn ensure_embedded_runtime(
    app: &AppHandle,
    profile: RapidRuntimeProfile,
    paths: RuntimePaths,
    requirements: &Path,
    constraints: &Path,
    wheelhouse: &Path,
) -> Result<RuntimePaths, String> {
    if paths.is_rapid_ready(profile) {
        return Ok(paths);
    }
    log::info!(
        "RapidOCR {} is not provisioned; installing from embedded wheelhouse",
        paddle_runtime::RAPID_RUNTIME_VERSION
    );
    paddle_runtime::install_managed_rapid_runtime(
        app,
        profile,
        requirements,
        constraints,
        wheelhouse,
    )
}

fn resolve_status(
    mode: RapidDeviceMode,
    profile: RapidRuntimeProfile,
    paths: RuntimePaths,
    script: &Path,
) -> Result<RapidOcrStatus, String> {
    if !paths.is_rapid_ready(profile) {
        return Ok(unavailable_status(
            mode,
            profile,
            &paths,
            "RapidOCR is not installed. Install the managed runtime to continue.",
        ));
    }
    let environment = probe_environment(&paths.python, &paths, script, mode)?;
    Ok(status_from_environment(mode, profile, &paths, environment))
}

fn probe_environment(
    python: &Path,
    paths: &RuntimePaths,
    script: &Path,
    mode: RapidDeviceMode,
) -> Result<WorkerEnvironment, String> {
    let mut command = hidden_command(python);
    paddle_runtime::configure_python_command(&mut command, paths);
    let output = command
        .arg(script)
        .arg("--check")
        .args(["--device", mode.as_str()])
        .output()
        .map_err(|error| {
            format!(
                "Cannot start RapidOCR runtime '{}': {error}",
                python.display()
            )
        })?;
    let mut environment = String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<WorkerEnvironment>(line).ok())
        .ok_or_else(|| {
            format!(
                "RapidOCR runtime check returned no status: {}",
                tail(&String::from_utf8_lossy(&output.stderr), 2_000)
            )
        })?;
    if !output.status.success() {
        environment.available = false;
        if environment.error.is_none() {
            environment.error = Some(tail(&String::from_utf8_lossy(&output.stderr), 2_000));
        }
    }
    Ok(environment)
}

fn status_from_environment(
    mode: RapidDeviceMode,
    profile: RapidRuntimeProfile,
    paths: &RuntimePaths,
    environment: WorkerEnvironment,
) -> RapidOcrStatus {
    let available = environment.available;
    RapidOcrStatus {
        available,
        python_path: paths.python.to_string_lossy().to_string(),
        managed: true,
        install_supported: true,
        install_required: !available,
        runtime_version: Some(paddle_runtime::RAPID_RUNTIME_VERSION.to_string()),
        rapidocr_version: environment.rapidocr_version,
        onnxruntime_version: environment.onnxruntime_version,
        pymupdf_version: environment.pymupdf_version,
        requested_device_mode: mode.as_str().to_string(),
        requested_provider: environment.requested_provider,
        active_provider: environment.active_provider,
        accelerated: environment.accelerated,
        available_providers: environment.available_providers,
        session_providers: environment.session_providers,
        runtime_profile: Some(profile.as_str().to_string()),
        fallback_reason: environment.fallback_reason,
        error: (!available).then(|| {
            environment
                .error
                .unwrap_or_else(|| "RapidOCR runtime check failed".to_string())
        }),
    }
}

fn unavailable_status(
    mode: RapidDeviceMode,
    profile: RapidRuntimeProfile,
    paths: &RuntimePaths,
    error: &str,
) -> RapidOcrStatus {
    RapidOcrStatus {
        available: false,
        python_path: paths.python.to_string_lossy().to_string(),
        managed: true,
        install_supported: true,
        install_required: true,
        runtime_version: Some(paddle_runtime::RAPID_RUNTIME_VERSION.to_string()),
        rapidocr_version: None,
        onnxruntime_version: None,
        pymupdf_version: None,
        requested_device_mode: mode.as_str().to_string(),
        requested_provider: Some(profile.expected_provider().to_string()),
        active_provider: None,
        accelerated: false,
        available_providers: Vec::new(),
        session_providers: Vec::new(),
        runtime_profile: Some(profile.as_str().to_string()),
        fallback_reason: None,
        error: Some(error.to_string()),
    }
}

fn unsupported_status(mode: RapidDeviceMode, error: String) -> RapidOcrStatus {
    RapidOcrStatus {
        available: false,
        python_path: String::new(),
        managed: true,
        install_supported: false,
        install_required: true,
        runtime_version: Some(paddle_runtime::RAPID_RUNTIME_VERSION.to_string()),
        rapidocr_version: None,
        onnxruntime_version: None,
        pymupdf_version: None,
        requested_device_mode: mode.as_str().to_string(),
        requested_provider: None,
        active_provider: None,
        accelerated: false,
        available_providers: Vec::new(),
        session_providers: Vec::new(),
        runtime_profile: None,
        fallback_reason: None,
        error: Some(error),
    }
}

fn worker_script(app: &AppHandle) -> Result<PathBuf, String> {
    resource_file(app, "rapid_ocr_worker.py")
}

fn requirements_path(app: &AppHandle, profile: RapidRuntimeProfile) -> Result<PathBuf, String> {
    resource_file(
        app,
        match profile {
            RapidRuntimeProfile::DirectMl => "rapidocr-directml-requirements.txt",
            RapidRuntimeProfile::CoreMl => "rapidocr-coreml-requirements.txt",
        },
    )
}

fn constraints_path(app: &AppHandle) -> Result<PathBuf, String> {
    resource_file(app, "rapidocr-constraints.txt")
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
        .ok_or_else(|| format!("RapidOCR resource '{name}' was not found"))
}

fn setting(db: &Database, key: &str, default: &str) -> String {
    let conn = db.get_connection();
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
        row.get(0)
    })
    .unwrap_or_else(|_| default.to_string())
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
    use super::{tail, RapidDeviceMode};

    #[test]
    fn device_mode_defaults_to_automatic_acceleration() {
        assert_eq!(RapidDeviceMode::parse("auto"), RapidDeviceMode::Auto);
        assert_eq!(RapidDeviceMode::parse("unexpected"), RapidDeviceMode::Auto);
        assert_eq!(RapidDeviceMode::parse("cpu"), RapidDeviceMode::Cpu);
    }

    #[test]
    fn development_worker_assets_exist() {
        let scripts = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts");
        for name in [
            "rapid_ocr_worker.py",
            "rapidocr-directml-requirements.txt",
            "rapidocr-coreml-requirements.txt",
            "rapidocr-constraints.txt",
        ] {
            assert!(scripts.join(name).is_file(), "missing {name}");
        }
    }

    #[test]
    fn keeps_only_requested_error_tail() {
        assert_eq!(tail("abcdef", 3), "def");
    }
}
