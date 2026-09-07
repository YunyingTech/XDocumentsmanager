use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::ocr::{
    get_file_abs_path, persist_ocr_text_async, resolve_output_dir, WindowsOcrProgress,
};
use crate::commands::ocr_control::OcrTaskManager;
use crate::db::Database;
use crate::paddle_runtime::{self, RuntimePaths, RuntimeProfile};

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
    pub requested_device_mode: String,
    pub active_device: Option<String>,
    pub runtime_profile: Option<String>,
    pub gpu_detected: bool,
    pub gpu_compatible: bool,
    pub gpu_runtime_installed: bool,
    pub gpu_name: Option<String>,
    pub gpu_compute_capability: Option<String>,
    pub gpu_driver_version: Option<String>,
    pub cuda_version: Option<String>,
    pub cudnn_version: Option<String>,
    pub fallback_reason: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PaddleDeviceMode {
    Auto,
    Cpu,
    Cuda12,
}

impl PaddleDeviceMode {
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "cpu" => Self::Cpu,
            "cuda12" | "cuda" | "gpu" => Self::Cuda12,
            _ => Self::Auto,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
            Self::Cuda12 => "cuda12",
        }
    }
}

#[derive(Debug, Clone)]
struct NvidiaGpuInfo {
    detected: bool,
    compatible: bool,
    name: Option<String>,
    compute_capability: Option<String>,
    driver_version: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct RuntimeSelection {
    paths: RuntimePaths,
    python: PathBuf,
    managed: bool,
    profile: RuntimeProfile,
    device: &'static str,
    fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct WorkerEnvironment {
    available: bool,
    paddle_version: Option<String>,
    paddleocr_version: Option<String>,
    active_device: Option<String>,
    compiled_with_cuda: Option<bool>,
    cuda_device_count: Option<u32>,
    cuda_version: Option<String>,
    cudnn_version: Option<String>,
    gpu_name: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct CachedCudaEnvironment {
    python: PathBuf,
    environment: WorkerEnvironment,
}

static CUDA_ENVIRONMENT_CACHE: OnceLock<Mutex<Option<CachedCudaEnvironment>>> = OnceLock::new();

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
    let mode = PaddleDeviceMode::parse(&setting(&db, "paddle_device_mode", "auto"));
    let configured_python = setting(&db, "paddle_python_path", "");
    let cpu_paths = RuntimePaths::for_app(&app, RuntimeProfile::Cpu)?;
    let cuda_paths = RuntimePaths::for_app(&app, RuntimeProfile::Cuda126)?;
    let script = worker_script(&app)?;
    tokio::task::spawn_blocking(move || {
        resolve_status(mode, &configured_python, cpu_paths, cuda_paths, &script)
    })
    .await
    .map_err(|error| format!("PaddleOCR status task failed: {error}"))?
}

#[tauri::command]
pub async fn install_paddle_ocr(
    primary_index: Option<String>,
    fallback_index: Option<String>,
    device_mode: Option<String>,
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<PaddleOcrStatus, String> {
    let mode = PaddleDeviceMode::parse(
        &device_mode.unwrap_or_else(|| setting(&db, "paddle_device_mode", "auto")),
    );
    let gpu = detect_nvidia_gpu();
    let profile = install_profile(mode, &gpu)?;
    let requirements = requirements_path(&app, profile)?;
    let constraints = constraints_path(&app)?;
    let script = worker_script(&app)?;
    let configured_python = setting(&db, "paddle_python_path", "");
    let cpu_paths = RuntimePaths::for_app(&app, RuntimeProfile::Cpu)?;
    let cuda_paths = RuntimePaths::for_app(&app, RuntimeProfile::Cuda126)?;
    let primary_index =
        primary_index.unwrap_or_else(|| setting(&db, "paddle_pypi_primary", "ustc"));
    let fallback_index =
        fallback_index.unwrap_or_else(|| setting(&db, "paddle_pypi_fallback", "tsinghua"));
    let package_indexes = paddle_runtime::package_index_urls(&primary_index, &fallback_index);
    let app_for_install = app.clone();
    log::info!(
        "PaddleOCR managed runtime installation started: profile={}, package indexes: {}",
        profile.as_str(),
        package_indexes.join(", ")
    );
    let status = tokio::task::spawn_blocking(move || -> Result<PaddleOcrStatus, String> {
        paddle_runtime::install_managed_runtime(
            &app_for_install,
            profile,
            &requirements,
            &constraints,
            &package_indexes,
        )?;
        resolve_status(mode, &configured_python, cpu_paths, cuda_paths, &script)
    })
    .await
    .map_err(|error| format!("PaddleOCR installer task failed: {error}"))??;
    if profile == RuntimeProfile::Cpu {
        set_setting(&db, "paddle_python_path", "")?;
    }
    log::info!(
        "PaddleOCR managed runtime installation completed: profile={}",
        profile.as_str()
    );
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
    let mode = PaddleDeviceMode::parse(&setting(&db, "paddle_device_mode", "auto"));
    let configured_python = setting(&db, "paddle_python_path", "");
    let cpu_paths = RuntimePaths::for_app(&app, RuntimeProfile::Cpu)?;
    let cuda_paths = RuntimePaths::for_app(&app, RuntimeProfile::Cuda126)?;
    let script = worker_script(&app)?;
    let script_for_probe = script.clone();
    let selection = tokio::task::spawn_blocking(move || {
        let gpu = detect_nvidia_gpu();
        let selection = select_runtime(
            mode,
            &configured_python,
            cpu_paths.clone(),
            cuda_paths,
            &gpu,
        )?;
        let (selection, environment) = probe_with_auto_fallback(
            mode,
            &configured_python,
            cpu_paths,
            selection,
            &script_for_probe,
            true,
        )?;
        if environment.available {
            Ok(selection)
        } else {
            Err(environment
                .error
                .unwrap_or_else(|| "PaddleOCR runtime check failed".to_string()))
        }
    })
    .await
    .map_err(|error| format!("PaddleOCR runtime selection task failed: {error}"))??;
    let active_device = selection.device;
    let runtime_profile = selection.profile;
    let runtime_paths = selection.paths;
    let python_path = selection.python;
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
    let language = language.unwrap_or_else(|| "ch".to_string());
    let model = model.unwrap_or_else(|| "PP-OCRv5_mobile".to_string());
    let started = Instant::now();
    log::info!(
        "PaddleOCR [{}] started: file_id={}, file='{}', language='{}', model='{}', device='{}', profile='{}'",
        task_id,
        file_id,
        file_name,
        language,
        model,
        active_device,
        runtime_profile.as_str()
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
            active_device,
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
    device: &str,
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
        .args([
            "--input",
            input,
            "--language",
            language,
            "--model",
            model,
            "--device",
            device,
        ])
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

fn resolve_status(
    mode: PaddleDeviceMode,
    configured_python: &str,
    cpu_paths: RuntimePaths,
    cuda_paths: RuntimePaths,
    script: &Path,
) -> Result<PaddleOcrStatus, String> {
    let gpu = detect_nvidia_gpu();
    let gpu_runtime_installed = cuda_paths.is_ready(RuntimeProfile::Cuda126);
    let selection = match select_runtime(
        mode,
        configured_python,
        cpu_paths.clone(),
        cuda_paths.clone(),
        &gpu,
    ) {
        Ok(selection) => selection,
        Err(error) => {
            return Ok(unavailable_status(
                mode,
                &cpu_paths,
                &cuda_paths,
                &gpu,
                &error,
            ));
        }
    };
    let (selection, environment) =
        probe_with_auto_fallback(mode, configured_python, cpu_paths, selection, script, false)?;

    Ok(status_from_environment(
        mode,
        &selection,
        environment,
        &gpu,
        gpu_runtime_installed,
    ))
}

fn probe_with_auto_fallback(
    mode: PaddleDeviceMode,
    configured_python: &str,
    cpu_paths: RuntimePaths,
    selection: RuntimeSelection,
    script: &Path,
    allow_cached_cuda: bool,
) -> Result<(RuntimeSelection, WorkerEnvironment), String> {
    let environment = probe_selected_environment(&selection, script, allow_cached_cuda)?;
    if should_auto_fallback(mode, selection.profile, environment.available) {
        let reason = environment.error.clone().unwrap_or_else(|| {
            format!(
                "The CUDA {} runtime failed its device check; using CPU.",
                paddle_runtime::CUDA_VERSION
            )
        });
        if let Some(mut cpu) = cpu_selection(configured_python, cpu_paths) {
            cpu.fallback_reason = Some(reason);
            let cpu_environment = probe_environment(&cpu, script)?;
            return Ok((cpu, cpu_environment));
        }
    }
    Ok((selection, environment))
}

fn should_auto_fallback(mode: PaddleDeviceMode, profile: RuntimeProfile, available: bool) -> bool {
    mode == PaddleDeviceMode::Auto && profile == RuntimeProfile::Cuda126 && !available
}

fn probe_selected_environment(
    selection: &RuntimeSelection,
    script: &Path,
    allow_cached_cuda: bool,
) -> Result<WorkerEnvironment, String> {
    if selection.profile != RuntimeProfile::Cuda126 {
        return probe_environment(selection, script);
    }
    let cache = CUDA_ENVIRONMENT_CACHE.get_or_init(|| Mutex::new(None));
    if allow_cached_cuda {
        let cached = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(cached) = cached.filter(|cached| cached.python == selection.python) {
            return Ok(cached.environment);
        }
    }
    let environment =
        probe_environment(selection, script).unwrap_or_else(|error| WorkerEnvironment {
            available: false,
            error: Some(error),
            ..WorkerEnvironment::default()
        });
    *cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(CachedCudaEnvironment {
        python: selection.python.clone(),
        environment: environment.clone(),
    });
    Ok(environment)
}

fn select_runtime(
    mode: PaddleDeviceMode,
    configured_python: &str,
    cpu_paths: RuntimePaths,
    cuda_paths: RuntimePaths,
    gpu: &NvidiaGpuInfo,
) -> Result<RuntimeSelection, String> {
    match mode {
        PaddleDeviceMode::Cpu => cpu_selection(configured_python, cpu_paths).ok_or_else(|| {
            "The PaddleOCR CPU runtime is not installed. Install the managed runtime before starting OCR."
                .to_string()
        }),
        PaddleDeviceMode::Cuda12 => {
            if !paddle_runtime::profile_install_supported(RuntimeProfile::Cuda126) {
                return Err(paddle_runtime::unsupported_profile_message(
                    RuntimeProfile::Cuda126,
                ));
            }
            if !gpu.compatible {
                return Err(gpu_requirement_error(gpu));
            }
            if !cuda_paths.is_ready(RuntimeProfile::Cuda126) {
                return Err(format!(
                    "The PaddleOCR CUDA {} runtime is not installed. Install it before starting OCR.",
                    paddle_runtime::CUDA_VERSION
                ));
            }
            Ok(RuntimeSelection {
                python: cuda_paths.python.clone(),
                paths: cuda_paths,
                managed: true,
                profile: RuntimeProfile::Cuda126,
                device: "gpu:0",
                fallback_reason: None,
            })
        }
        PaddleDeviceMode::Auto => {
            if gpu.compatible && cuda_paths.is_ready(RuntimeProfile::Cuda126) {
                return Ok(RuntimeSelection {
                    python: cuda_paths.python.clone(),
                    paths: cuda_paths,
                    managed: true,
                    profile: RuntimeProfile::Cuda126,
                    device: "gpu:0",
                    fallback_reason: None,
                });
            }
            let mut cpu = cpu_selection(configured_python, cpu_paths).ok_or_else(|| {
                if gpu.compatible {
                    format!(
                        "No PaddleOCR runtime is installed. Install the CUDA {} runtime to use the detected NVIDIA GPU.",
                        paddle_runtime::CUDA_VERSION
                    )
                } else {
                    "PaddleOCR is not installed. Install the managed runtime to continue.".to_string()
                }
            })?;
            if gpu.compatible {
                cpu.fallback_reason = Some(format!(
                    "A compatible NVIDIA GPU was detected, but the CUDA {} runtime is not installed; using CPU.",
                    paddle_runtime::CUDA_VERSION
                ));
            } else if gpu.detected {
                cpu.fallback_reason = Some(gpu_requirement_error(gpu));
            }
            Ok(cpu)
        }
    }
}

fn cpu_selection(configured_python: &str, paths: RuntimePaths) -> Option<RuntimeSelection> {
    if paths.is_ready(RuntimeProfile::Cpu) {
        return Some(RuntimeSelection {
            python: paths.python.clone(),
            paths,
            managed: true,
            profile: RuntimeProfile::Cpu,
            device: "cpu",
            fallback_reason: None,
        });
    }
    let configured = configured_python.trim();
    if !configured.is_empty() && !configured.eq_ignore_ascii_case("python") {
        let python = PathBuf::from(configured);
        if python.is_file() {
            return Some(RuntimeSelection {
                python,
                paths,
                managed: false,
                profile: RuntimeProfile::Cpu,
                device: "cpu",
                fallback_reason: None,
            });
        }
    }
    None
}

fn probe_environment(
    selection: &RuntimeSelection,
    script: &Path,
) -> Result<WorkerEnvironment, String> {
    let mut command = hidden_command(&selection.python);
    paddle_runtime::configure_python_command(&mut command, &selection.paths);
    let output = command
        .arg(script)
        .arg("--check")
        .args(["--device", selection.device])
        .output()
        .map_err(|error| {
            format!(
                "Cannot start PaddleOCR runtime '{}': {error}",
                selection.python.display()
            )
        })?;
    let mut environment = String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<WorkerEnvironment>(line).ok())
        .ok_or_else(|| {
            format!(
                "PaddleOCR runtime check returned no status: {}",
                tail(&String::from_utf8_lossy(&output.stderr), 2_000)
            )
        })?;
    if !output.status.success() {
        environment.available = false;
        if environment.error.is_none() {
            environment.error = Some(tail(&String::from_utf8_lossy(&output.stderr), 2_000));
        }
    }
    if selection.profile == RuntimeProfile::Cuda126 {
        if environment.compiled_with_cuda != Some(true) {
            environment.available = false;
            environment.error = Some(
                "The selected managed runtime is not a CUDA-enabled PaddlePaddle build".to_string(),
            );
        } else if !environment
            .cuda_version
            .as_deref()
            .is_some_and(|version| version.starts_with(paddle_runtime::CUDA_VERSION))
        {
            environment.available = false;
            environment.error = Some(format!(
                "The selected managed runtime uses CUDA {}, but CUDA {} is required",
                environment.cuda_version.as_deref().unwrap_or("unknown"),
                paddle_runtime::CUDA_VERSION
            ));
        }
    }
    Ok(environment)
}

fn status_from_environment(
    mode: PaddleDeviceMode,
    selection: &RuntimeSelection,
    environment: WorkerEnvironment,
    gpu: &NvidiaGpuInfo,
    gpu_runtime_installed: bool,
) -> PaddleOcrStatus {
    let available = environment.available;
    let worker_gpu_available = environment.cuda_device_count.unwrap_or(0) > 0;
    PaddleOcrStatus {
        available,
        python_path: selection.python.to_string_lossy().to_string(),
        managed: selection.managed,
        install_supported: paddle_runtime::install_supported(),
        install_required: !available,
        runtime_version: selection
            .managed
            .then(|| paddle_runtime::RUNTIME_VERSION.to_string()),
        paddle_version: environment.paddle_version,
        paddleocr_version: environment.paddleocr_version,
        requested_device_mode: mode.as_str().to_string(),
        active_device: environment
            .active_device
            .or_else(|| available.then(|| selection.device.to_string())),
        runtime_profile: Some(selection.profile.as_str().to_string()),
        gpu_detected: gpu.detected || worker_gpu_available,
        gpu_compatible: gpu.compatible
            || (selection.profile == RuntimeProfile::Cuda126 && available),
        gpu_runtime_installed,
        gpu_name: environment.gpu_name.or_else(|| gpu.name.clone()),
        gpu_compute_capability: gpu.compute_capability.clone(),
        gpu_driver_version: gpu.driver_version.clone(),
        cuda_version: environment.cuda_version,
        cudnn_version: environment.cudnn_version,
        fallback_reason: selection.fallback_reason.clone(),
        error: (!available).then(|| {
            environment
                .error
                .unwrap_or_else(|| "PaddleOCR runtime check failed".to_string())
        }),
    }
}

fn unavailable_status(
    mode: PaddleDeviceMode,
    cpu_paths: &RuntimePaths,
    cuda_paths: &RuntimePaths,
    gpu: &NvidiaGpuInfo,
    error: &str,
) -> PaddleOcrStatus {
    let path = if mode == PaddleDeviceMode::Cuda12 {
        &cuda_paths.python
    } else {
        &cpu_paths.python
    };
    PaddleOcrStatus {
        available: false,
        python_path: path.to_string_lossy().to_string(),
        managed: true,
        install_supported: paddle_runtime::install_supported(),
        install_required: true,
        runtime_version: Some(paddle_runtime::RUNTIME_VERSION.to_string()),
        paddle_version: None,
        paddleocr_version: None,
        requested_device_mode: mode.as_str().to_string(),
        active_device: None,
        runtime_profile: None,
        gpu_detected: gpu.detected,
        gpu_compatible: gpu.compatible,
        gpu_runtime_installed: cuda_paths.is_ready(RuntimeProfile::Cuda126),
        gpu_name: gpu.name.clone(),
        gpu_compute_capability: gpu.compute_capability.clone(),
        gpu_driver_version: gpu.driver_version.clone(),
        cuda_version: None,
        cudnn_version: None,
        fallback_reason: None,
        error: Some(if paddle_runtime::install_supported() {
            error.to_string()
        } else {
            paddle_runtime::unsupported_message()
        }),
    }
}

fn install_profile(mode: PaddleDeviceMode, gpu: &NvidiaGpuInfo) -> Result<RuntimeProfile, String> {
    match mode {
        PaddleDeviceMode::Cpu => Ok(RuntimeProfile::Cpu),
        PaddleDeviceMode::Auto => {
            if gpu.compatible && paddle_runtime::profile_install_supported(RuntimeProfile::Cuda126)
            {
                Ok(RuntimeProfile::Cuda126)
            } else {
                Ok(RuntimeProfile::Cpu)
            }
        }
        PaddleDeviceMode::Cuda12 => {
            if !paddle_runtime::profile_install_supported(RuntimeProfile::Cuda126) {
                return Err(paddle_runtime::unsupported_profile_message(
                    RuntimeProfile::Cuda126,
                ));
            }
            if !gpu.compatible {
                return Err(gpu_requirement_error(gpu));
            }
            Ok(RuntimeProfile::Cuda126)
        }
    }
}

fn detect_nvidia_gpu() -> NvidiaGpuInfo {
    let mut command = hidden_command("nvidia-smi");
    let output = match command
        .args([
            "--query-gpu=name,compute_cap,driver_version",
            "--format=csv,noheader,nounits",
        ])
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return NvidiaGpuInfo {
                detected: false,
                compatible: false,
                name: None,
                compute_capability: None,
                driver_version: None,
                error: Some(format!(
                    "NVIDIA driver utility nvidia-smi is unavailable: {error}"
                )),
            };
        }
    };
    if !output.status.success() {
        return NvidiaGpuInfo {
            detected: false,
            compatible: false,
            name: None,
            compute_capability: None,
            driver_version: None,
            error: Some(format!(
                "NVIDIA driver detection failed: {}",
                tail(&String::from_utf8_lossy(&output.stderr), 1_000)
            )),
        };
    }
    parse_nvidia_smi(&String::from_utf8_lossy(&output.stdout))
}

fn parse_nvidia_smi(output: &str) -> NvidiaGpuInfo {
    let mut first = None;
    let mut compatible = None;
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let fields = line.splitn(3, ',').map(str::trim).collect::<Vec<_>>();
        if fields.len() != 3 {
            continue;
        }
        let capability = fields[1].parse::<f32>().ok();
        let candidate = NvidiaGpuInfo {
            detected: true,
            compatible: capability.is_some_and(|value| value >= 7.5),
            name: Some(fields[0].to_string()),
            compute_capability: Some(fields[1].to_string()),
            driver_version: Some(fields[2].to_string()),
            error: None,
        };
        if first.is_none() {
            first = Some(candidate.clone());
        }
        if candidate.compatible {
            compatible = Some(candidate);
            break;
        }
    }
    compatible.or(first).unwrap_or_else(|| NvidiaGpuInfo {
        detected: false,
        compatible: false,
        name: None,
        compute_capability: None,
        driver_version: None,
        error: Some("nvidia-smi returned no GPU information".to_string()),
    })
}

fn gpu_requirement_error(gpu: &NvidiaGpuInfo) -> String {
    if gpu.detected {
        format!(
            "PaddleOCR CUDA {} requires an NVIDIA GPU with compute capability 7.5 or newer; detected {} (compute capability {}).",
            paddle_runtime::CUDA_VERSION,
            gpu.name.as_deref().unwrap_or("NVIDIA GPU"),
            gpu.compute_capability.as_deref().unwrap_or("unknown")
        )
    } else {
        format!(
            "PaddleOCR CUDA {} requires a compatible NVIDIA GPU and driver. {}",
            paddle_runtime::CUDA_VERSION,
            gpu.error
                .as_deref()
                .unwrap_or("No NVIDIA GPU was detected.")
        )
    }
}

fn worker_script(app: &AppHandle) -> Result<PathBuf, String> {
    resource_file(app, "paddle_ocr_worker.py")
}

fn requirements_path(app: &AppHandle, profile: RuntimeProfile) -> Result<PathBuf, String> {
    resource_file(
        app,
        match profile {
            RuntimeProfile::Cpu => "paddleocr-requirements.txt",
            RuntimeProfile::Cuda126 => "paddleocr-gpu-requirements.txt",
        },
    )
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
    use super::{
        install_profile, parse_nvidia_smi, should_auto_fallback, tail, worker_script,
        NvidiaGpuInfo, PaddleDeviceMode,
    };
    use crate::paddle_runtime::RuntimeProfile;

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
        assert!(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("scripts")
            .join("paddleocr-gpu-requirements.txt")
            .is_file());
        let _ = worker_script;
    }

    #[test]
    fn selects_the_first_cuda_compatible_nvidia_gpu() {
        let gpu = parse_nvidia_smi("GeForce GTX 1080, 6.1, 580.88\nNVIDIA RTX 4070, 8.9, 580.88\n");
        assert!(gpu.detected);
        assert!(gpu.compatible);
        assert_eq!(gpu.name.as_deref(), Some("NVIDIA RTX 4070"));
        assert_eq!(gpu.compute_capability.as_deref(), Some("8.9"));
    }

    #[test]
    fn rejects_an_explicit_cuda_install_without_compatible_hardware() {
        let gpu = NvidiaGpuInfo {
            detected: true,
            compatible: false,
            name: Some("GeForce GTX 1080".to_string()),
            compute_capability: Some("6.1".to_string()),
            driver_version: Some("580.88".to_string()),
            error: None,
        };
        let error = install_profile(PaddleDeviceMode::Cuda12, &gpu).unwrap_err();
        if crate::paddle_runtime::profile_install_supported(RuntimeProfile::Cuda126) {
            assert!(error.contains("compute capability 7.5"));
        } else {
            assert_eq!(
                error,
                crate::paddle_runtime::unsupported_profile_message(RuntimeProfile::Cuda126)
            );
        }
        assert_eq!(
            install_profile(PaddleDeviceMode::Auto, &gpu).unwrap(),
            RuntimeProfile::Cpu
        );
    }

    #[test]
    fn only_automatic_cuda_selection_falls_back_after_a_failed_probe() {
        assert!(should_auto_fallback(
            PaddleDeviceMode::Auto,
            RuntimeProfile::Cuda126,
            false
        ));
        assert!(!should_auto_fallback(
            PaddleDeviceMode::Cuda12,
            RuntimeProfile::Cuda126,
            false
        ));
        assert!(!should_auto_fallback(
            PaddleDeviceMode::Auto,
            RuntimeProfile::Cpu,
            false
        ));
        assert!(!should_auto_fallback(
            PaddleDeviceMode::Auto,
            RuntimeProfile::Cuda126,
            true
        ));
    }

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    #[test]
    fn automatic_install_prefers_cuda_on_compatible_windows_hardware() {
        let gpu = NvidiaGpuInfo {
            detected: true,
            compatible: true,
            name: Some("NVIDIA RTX 4070".to_string()),
            compute_capability: Some("8.9".to_string()),
            driver_version: Some("580.88".to_string()),
            error: None,
        };
        assert_eq!(
            install_profile(PaddleDeviceMode::Auto, &gpu).unwrap(),
            RuntimeProfile::Cuda126
        );
    }
}
