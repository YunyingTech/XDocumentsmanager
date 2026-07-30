use std::collections::{HashSet, VecDeque};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

pub const RUNTIME_VERSION: &str = "3";
pub const RAPID_RUNTIME_VERSION: &str = "2";
const RAPID_WHEELHOUSE_VERSION: u32 = 1;
const PYTHON_VERSION: &str = "3.11";
const PADDLE_VERSION: &str = "3.3.1";
const PADDLEOCR_VERSION: &str = "3.3.1";
pub const RAPIDOCR_VERSION: &str = "3.9.2";
pub const RAPID_ORT_VERSION: &str = "1.24.4";
const PYMUPDF_VERSION: &str = "1.24.14";
pub const CUDA_VERSION: &str = "12.6";
const CUDA_PACKAGE_INDEX: &str = "https://www.paddlepaddle.org.cn/packages/stable/cu126/";
const PIP_WHEEL: &str = "pip-25.1.1-py3-none-any.whl";
const PIP_WHEEL_SHA256: &str = "2913a38a2abf4ea6b64ab507bd9e967f3b53dc1ede74b01b0931e1ce548751af";
const SETUPTOOLS_WHEEL: &str = "setuptools-80.9.0-py3-none-any.whl";
const SETUPTOOLS_WHEEL_SHA256: &str =
    "062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922";
const WHEEL_WHEEL: &str = "wheel-0.45.1-py3-none-any.whl";
const WHEEL_WHEEL_SHA256: &str = "708e7481cc80179af0e556bbf0cc00b8444c7321e2700b8d8580231d13017248";
const USTC_PYPI_URL: &str = "https://mirrors.ustc.edu.cn/pypi/simple";
const TSINGHUA_PYPI_URL: &str = "https://pypi.tuna.tsinghua.edu.cn/simple";
const OFFICIAL_PYPI_URL: &str = "https://pypi.org/simple";

static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeProfile {
    Cpu,
    Cuda126,
}

impl RuntimeProfile {
    pub fn directory_name(self) -> String {
        format!("{}-v{RUNTIME_VERSION}", self.as_str())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Cuda126 => "cu126",
        }
    }

    fn paddle_package(self) -> &'static str {
        match self {
            Self::Cpu => "paddlepaddle",
            Self::Cuda126 => "paddlepaddle-gpu",
        }
    }

    fn expects_cuda(self) -> bool {
        matches!(self, Self::Cuda126)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RapidRuntimeProfile {
    DirectMl,
    CoreMl,
}

impl RapidRuntimeProfile {
    pub fn directory_name(self) -> String {
        format!("{}-v{RAPID_RUNTIME_VERSION}", self.as_str())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::DirectMl => "directml",
            Self::CoreMl => "coreml",
        }
    }

    fn provider_package(self) -> &'static str {
        match self {
            Self::DirectMl => "onnxruntime-directml",
            Self::CoreMl => "onnxruntime",
        }
    }

    pub fn expected_provider(self) -> &'static str {
        match self {
            Self::DirectMl => "DmlExecutionProvider",
            Self::CoreMl => "CoreMLExecutionProvider",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeInstallProgress {
    pub stage: &'static str,
    pub progress: u8,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    pub root: PathBuf,
    pub install_dir: PathBuf,
    pub python: PathBuf,
    pub model_cache: PathBuf,
    pub pip_cache: PathBuf,
    manifest: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct RuntimeManifest {
    runtime_version: String,
    profile: RuntimeProfile,
    python_version: String,
    paddle_package: String,
    paddle_version: String,
    paddleocr_version: String,
    cuda_version: Option<String>,
    requirements_sha256: String,
    constraints_sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct RapidRuntimeManifest {
    runtime_version: String,
    profile: RapidRuntimeProfile,
    python_version: String,
    rapidocr_version: String,
    onnxruntime_package: String,
    onnxruntime_version: String,
    pymupdf_version: String,
    available_providers: Vec<String>,
    wheelhouse_sha256: String,
    requirements_sha256: String,
    constraints_sha256: String,
}

#[derive(Debug, Deserialize)]
struct EmbeddedRapidWheelhouseManifest {
    version: u32,
    profile: String,
    python_version: String,
    requirements_sha256: String,
    constraints_sha256: String,
    files: Vec<EmbeddedRapidWheel>,
}

#[derive(Debug, Deserialize)]
struct EmbeddedRapidWheel {
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RuntimeProbe {
    python: String,
    paddle: String,
    paddleocr: String,
    compiled_with_cuda: bool,
    cuda: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RapidRuntimeProbe {
    python: String,
    rapidocr: String,
    onnxruntime: String,
    pymupdf: String,
    providers: Vec<String>,
}

#[derive(Clone, Copy)]
#[allow(dead_code)]
enum ArchiveKind {
    Zip,
    TarGz,
}

struct BundleSpec {
    archive_name: &'static str,
    archive_sha256: &'static str,
    kind: ArchiveKind,
}

impl RuntimePaths {
    pub fn for_app(app: &AppHandle, profile: RuntimeProfile) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("paddle-runtime");
        let install_dir = root.join(profile.directory_name());
        let python = install_dir.join(python_relative_path());
        Ok(Self {
            manifest: install_dir.join("runtime-manifest.json"),
            model_cache: root.join("models"),
            pip_cache: root.join("pip-cache"),
            root,
            install_dir,
            python,
        })
    }

    pub fn for_rapid_app(app: &AppHandle, profile: RapidRuntimeProfile) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("rapidocr-runtime");
        let install_dir = root.join(profile.directory_name());
        let python = install_dir.join(python_relative_path());
        Ok(Self {
            manifest: install_dir.join("runtime-manifest.json"),
            model_cache: root.join("models"),
            pip_cache: root.join("pip-cache"),
            root,
            install_dir,
            python,
        })
    }

    pub fn is_ready(&self, profile: RuntimeProfile) -> bool {
        if !self.python.is_file() || !self.manifest.is_file() {
            return false;
        }
        fs::read_to_string(&self.manifest)
            .ok()
            .and_then(|contents| serde_json::from_str::<RuntimeManifest>(&contents).ok())
            .is_some_and(|manifest| {
                manifest.runtime_version == RUNTIME_VERSION
                    && manifest.profile == profile
                    && manifest.python_version.starts_with(PYTHON_VERSION)
                    && manifest.paddle_package == profile.paddle_package()
                    && manifest.paddle_version == PADDLE_VERSION
                    && manifest.paddleocr_version == PADDLEOCR_VERSION
                    && match profile {
                        RuntimeProfile::Cpu => manifest.cuda_version.is_none(),
                        RuntimeProfile::Cuda126 => manifest
                            .cuda_version
                            .as_deref()
                            .is_some_and(|version| version.starts_with(CUDA_VERSION)),
                    }
                    && manifest.requirements_sha256.len() == 64
                    && manifest.constraints_sha256.len() == 64
            })
    }

    pub fn is_rapid_ready(&self, profile: RapidRuntimeProfile) -> bool {
        if !self.python.is_file() || !self.manifest.is_file() {
            return false;
        }
        fs::read_to_string(&self.manifest)
            .ok()
            .and_then(|contents| serde_json::from_str::<RapidRuntimeManifest>(&contents).ok())
            .is_some_and(|manifest| {
                manifest.runtime_version == RAPID_RUNTIME_VERSION
                    && manifest.profile == profile
                    && manifest.python_version.starts_with(PYTHON_VERSION)
                    && manifest.rapidocr_version == RAPIDOCR_VERSION
                    && manifest.onnxruntime_package == profile.provider_package()
                    && manifest.onnxruntime_version == RAPID_ORT_VERSION
                    && manifest.pymupdf_version == PYMUPDF_VERSION
                    && manifest.wheelhouse_sha256.len() == 64
                    && manifest
                        .available_providers
                        .iter()
                        .any(|provider| provider == profile.expected_provider())
                    && manifest.requirements_sha256.len() == 64
                    && manifest.constraints_sha256.len() == 64
            })
    }
}

pub fn install_supported() -> bool {
    cfg!(all(target_os = "windows", target_arch = "x86_64"))
        || cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

pub fn profile_install_supported(profile: RuntimeProfile) -> bool {
    match profile {
        RuntimeProfile::Cpu => install_supported(),
        RuntimeProfile::Cuda126 => cfg!(all(target_os = "windows", target_arch = "x86_64")),
    }
}

pub fn rapid_runtime_profile() -> Result<RapidRuntimeProfile, String> {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Ok(RapidRuntimeProfile::DirectMl)
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok(RapidRuntimeProfile::CoreMl)
    } else {
        Err(format!(
            "The managed RapidOCR runtime is not available for {}/{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
    }
}

pub fn configure_python_command(command: &mut Command, paths: &RuntimePaths) {
    command
        .args(["-X", "utf8"])
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8:backslashreplace")
        .env("PYTHONNOUSERSITE", "1")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .env("PIP_NO_INPUT", "1")
        .env("PIP_CACHE_DIR", &paths.pip_cache)
        .env("PADDLE_HOME", &paths.model_cache)
        .env("PADDLEOCR_HOME", &paths.model_cache)
        .env("PADDLE_PDX_CACHE_HOME", &paths.model_cache)
        .env("PADDLE_PDX_MODEL_SOURCE", "modelscope")
        .env("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True");
}

pub fn install_managed_runtime(
    app: &AppHandle,
    profile: RuntimeProfile,
    requirements: &Path,
    constraints: &Path,
    package_indexes: &[String],
) -> Result<RuntimePaths, String> {
    if !profile_install_supported(profile) {
        return Err(unsupported_profile_message(profile));
    }
    let lock = INSTALL_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let paths = RuntimePaths::for_app(app, profile)?;
    if paths.is_ready(profile)
        && probe_runtime(&paths.python, &paths)
            .is_ok_and(|probe| runtime_probe_matches_profile(&probe, profile))
    {
        emit_progress(
            app,
            "completed",
            100,
            &format!(
                "PaddleOCR {} runtime is already installed",
                profile.as_str()
            ),
        );
        return Ok(paths);
    }
    if paths.install_dir.exists() {
        log::warn!("Existing PaddleOCR runtime did not pass verification and will be repaired");
    }

    fs::create_dir_all(&paths.root)
        .map_err(|error| format!("Cannot create PaddleOCR runtime directory: {error}"))?;
    cleanup_interrupted_installations(&paths.root);
    let staging = paths
        .root
        .join(format!(".installing-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Cannot create PaddleOCR staging directory: {error}"))?;

    let result = install_into(
        app,
        profile,
        requirements,
        constraints,
        package_indexes,
        &paths,
        &staging,
    );
    if let Err(error) = &result {
        let _ = fs::remove_dir_all(&staging);
        emit_progress(app, "failed", 100, error);
        log::error!("PaddleOCR managed runtime installation failed: {error}");
    }
    result.map(|_| paths)
}

pub fn install_managed_rapid_runtime(
    app: &AppHandle,
    profile: RapidRuntimeProfile,
    requirements: &Path,
    constraints: &Path,
    wheelhouse: &Path,
) -> Result<RuntimePaths, String> {
    let supported_profile = rapid_runtime_profile()?;
    if profile != supported_profile {
        return Err(format!(
            "RapidOCR runtime profile {} is not supported on this platform",
            profile.as_str()
        ));
    }
    let wheelhouse_sha256 =
        verify_rapid_wheelhouse(profile, requirements, constraints, wheelhouse)?;
    let lock = INSTALL_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let paths = RuntimePaths::for_rapid_app(app, profile)?;
    if paths.is_rapid_ready(profile)
        && probe_rapid_runtime(&paths.python, &paths)
            .is_ok_and(|probe| rapid_probe_matches_profile(&probe, profile))
    {
        emit_runtime_progress(
            app,
            "rapid-install:progress",
            "completed",
            100,
            &format!("RapidOCR {} runtime is already installed", profile.as_str()),
        );
        return Ok(paths);
    }
    if paths.install_dir.exists() {
        log::warn!("Existing RapidOCR runtime did not pass verification and will be repaired");
    }

    fs::create_dir_all(&paths.root)
        .map_err(|error| format!("Cannot create RapidOCR runtime directory: {error}"))?;
    cleanup_interrupted_installations(&paths.root);
    let staging = paths
        .root
        .join(format!(".installing-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("Cannot create RapidOCR staging directory: {error}"))?;

    let result = install_rapid_into(
        app,
        profile,
        requirements,
        constraints,
        wheelhouse,
        &wheelhouse_sha256,
        &paths,
        &staging,
    );
    if let Err(error) = &result {
        let _ = fs::remove_dir_all(&staging);
        emit_runtime_progress(app, "rapid-install:progress", "failed", 100, error);
        log::error!("RapidOCR managed runtime installation failed: {error}");
    }
    result.map(|_| paths)
}

fn install_rapid_into(
    app: &AppHandle,
    profile: RapidRuntimeProfile,
    requirements: &Path,
    constraints: &Path,
    wheelhouse: &Path,
    wheelhouse_sha256: &str,
    paths: &RuntimePaths,
    staging: &Path,
) -> Result<(), String> {
    let event = "rapid-install:progress";
    let spec = bundle_spec()?;
    emit_runtime_progress(
        app,
        event,
        "preparing",
        5,
        "Checking bundled Python runtime",
    );
    let archive = runtime_resource(app, spec.archive_name)?;
    verify_sha256(&archive, spec.archive_sha256)?;
    let pip_wheel = runtime_resource(app, PIP_WHEEL)?;
    verify_sha256(&pip_wheel, PIP_WHEEL_SHA256)?;
    let setuptools_wheel = runtime_resource(app, SETUPTOOLS_WHEEL)?;
    verify_sha256(&setuptools_wheel, SETUPTOOLS_WHEEL_SHA256)?;
    let wheel_wheel = runtime_resource(app, WHEEL_WHEEL)?;
    verify_sha256(&wheel_wheel, WHEEL_WHEEL_SHA256)?;

    emit_runtime_progress(
        app,
        event,
        "extracting",
        20,
        "Preparing the private Python runtime",
    );
    match spec.kind {
        ArchiveKind::Zip => extract_zip(&archive, staging)?,
        ArchiveKind::TarGz => extract_tar_gz(&archive, staging)?,
    }
    prepare_python(staging, &[pip_wheel, setuptools_wheel, wheel_wheel])?;
    let staging_python = staging.join(python_relative_path());
    if !staging_python.is_file() {
        return Err(format!(
            "Bundled Python runtime is incomplete: {} was not found",
            staging_python.display()
        ));
    }

    fs::create_dir_all(&paths.pip_cache)
        .map_err(|error| format!("Cannot create pip cache: {error}"))?;
    fs::create_dir_all(&paths.model_cache)
        .map_err(|error| format!("Cannot create RapidOCR model cache: {error}"))?;

    let mut pip_check = hidden_command(&staging_python);
    configure_python_command(&mut pip_check, paths);
    let pip_check = pip_check
        .args(["-I", "-m", "pip", "--version"])
        .output()
        .map_err(|error| format!("Cannot start bundled Python: {error}"))?;
    if !pip_check.status.success() {
        return Err(format!(
            "Bundled pip bootstrap failed: {}",
            output_error(&pip_check)
        ));
    }

    emit_runtime_progress(
        app,
        event,
        "installing",
        40,
        "Installing RapidOCR and ONNX Runtime components",
    );
    install_offline_requirements(
        &staging_python,
        paths,
        requirements,
        constraints,
        wheelhouse,
        app,
    )?;

    emit_runtime_progress(app, event, "verifying", 90, "Verifying RapidOCR components");
    let probe = probe_rapid_runtime(&staging_python, paths)?;
    if !rapid_probe_matches_profile(&probe, profile) {
        return Err(format!(
            "RapidOCR runtime verification failed: expected profile {}, Python {PYTHON_VERSION}, RapidOCR {RAPIDOCR_VERSION}, ONNX Runtime {RAPID_ORT_VERSION}, PyMuPDF {PYMUPDF_VERSION}; got Python {}, RapidOCR {}, ONNX Runtime {}, PyMuPDF {}, providers {:?}",
            profile.as_str(),
            probe.python,
            probe.rapidocr,
            probe.onnxruntime,
            probe.pymupdf,
            probe.providers
        ));
    }
    let manifest = RapidRuntimeManifest {
        runtime_version: RAPID_RUNTIME_VERSION.to_string(),
        profile,
        python_version: probe.python,
        rapidocr_version: probe.rapidocr,
        onnxruntime_package: profile.provider_package().to_string(),
        onnxruntime_version: probe.onnxruntime,
        pymupdf_version: probe.pymupdf,
        available_providers: probe.providers,
        wheelhouse_sha256: wheelhouse_sha256.to_string(),
        requirements_sha256: file_sha256(requirements)?,
        constraints_sha256: file_sha256(constraints)?,
    };
    fs::write(
        staging.join("runtime-manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Cannot write RapidOCR runtime manifest: {error}"))?;

    promote_runtime(&paths.install_dir, staging)?;
    emit_runtime_progress(
        app,
        event,
        "completed",
        100,
        &format!("RapidOCR {} runtime is ready", profile.as_str()),
    );
    log::info!(
        "RapidOCR managed runtime {} ({}) installed at {}",
        RAPID_RUNTIME_VERSION,
        profile.as_str(),
        paths.install_dir.display()
    );
    Ok(())
}

fn install_offline_requirements(
    python: &Path,
    paths: &RuntimePaths,
    requirements: &Path,
    constraints: &Path,
    wheelhouse: &Path,
    app: &AppHandle,
) -> Result<(), String> {
    emit_runtime_progress(
        app,
        "rapid-install:progress",
        "installing",
        40,
        "Installing the embedded RapidOCR runtime without network access",
    );
    let mut install = hidden_command(python);
    configure_python_command(&mut install, paths);
    install.args([
        "-I",
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--no-index",
        "--progress-bar",
        "raw",
        "--only-binary=:all:",
        "--no-warn-script-location",
        "--find-links",
    ]);
    install
        .arg(wheelhouse)
        .arg("--constraint")
        .arg(constraints)
        .arg("--requirement")
        .arg(requirements);
    run_install_command(
        install,
        app,
        "rapid-install:progress",
        "RapidOCR",
    )
}

fn install_into(
    app: &AppHandle,
    profile: RuntimeProfile,
    requirements: &Path,
    constraints: &Path,
    package_indexes: &[String],
    paths: &RuntimePaths,
    staging: &Path,
) -> Result<(), String> {
    let spec = bundle_spec()?;
    emit_progress(app, "preparing", 5, "Checking bundled Python runtime");
    let archive = runtime_resource(app, spec.archive_name)?;
    verify_sha256(&archive, spec.archive_sha256)?;
    let pip_wheel = runtime_resource(app, PIP_WHEEL)?;
    verify_sha256(&pip_wheel, PIP_WHEEL_SHA256)?;
    let setuptools_wheel = runtime_resource(app, SETUPTOOLS_WHEEL)?;
    verify_sha256(&setuptools_wheel, SETUPTOOLS_WHEEL_SHA256)?;
    let wheel_wheel = runtime_resource(app, WHEEL_WHEEL)?;
    verify_sha256(&wheel_wheel, WHEEL_WHEEL_SHA256)?;

    emit_progress(
        app,
        "extracting",
        20,
        "Preparing the private Python runtime",
    );
    match spec.kind {
        ArchiveKind::Zip => extract_zip(&archive, staging)?,
        ArchiveKind::TarGz => extract_tar_gz(&archive, staging)?,
    }
    prepare_python(staging, &[pip_wheel, setuptools_wheel, wheel_wheel])?;
    let staging_python = staging.join(python_relative_path());
    if !staging_python.is_file() {
        return Err(format!(
            "Bundled Python runtime is incomplete: {} was not found",
            staging_python.display()
        ));
    }

    fs::create_dir_all(&paths.pip_cache)
        .map_err(|error| format!("Cannot create pip cache: {error}"))?;
    fs::create_dir_all(&paths.model_cache)
        .map_err(|error| format!("Cannot create Paddle model cache: {error}"))?;

    let mut pip_check = hidden_command(&staging_python);
    configure_python_command(&mut pip_check, paths);
    let pip_check = pip_check
        .args(["-I", "-m", "pip", "--version"])
        .output()
        .map_err(|error| format!("Cannot start bundled Python: {error}"))?;
    if !pip_check.status.success() {
        return Err(format!(
            "Bundled pip bootstrap failed: {}",
            output_error(&pip_check)
        ));
    }

    emit_progress(
        app,
        "installing",
        40,
        "Installing PaddleOCR components. The first installation can take several minutes.",
    );
    install_dependencies(
        &staging_python,
        paths,
        profile,
        requirements,
        constraints,
        package_indexes,
        app,
    )?;

    emit_progress(app, "verifying", 90, "Verifying PaddleOCR components");
    let probe = probe_runtime(&staging_python, paths)?;
    if !probe.python.starts_with(PYTHON_VERSION)
        || probe.paddle != PADDLE_VERSION
        || probe.paddleocr != PADDLEOCR_VERSION
        || !runtime_probe_matches_profile(&probe, profile)
    {
        return Err(format!(
            "PaddleOCR runtime verification failed: expected profile {}, Python {PYTHON_VERSION}, PaddlePaddle {PADDLE_VERSION}, PaddleOCR {PADDLEOCR_VERSION}; got Python {}, PaddlePaddle {}, PaddleOCR {}, CUDA build {}, CUDA version {}",
            profile.as_str(),
            probe.python,
            probe.paddle,
            probe.paddleocr,
            probe.compiled_with_cuda,
            probe.cuda.as_deref().unwrap_or("none")
        ));
    }
    let manifest = RuntimeManifest {
        runtime_version: RUNTIME_VERSION.to_string(),
        profile,
        python_version: probe.python,
        paddle_package: profile.paddle_package().to_string(),
        paddle_version: probe.paddle,
        paddleocr_version: probe.paddleocr,
        cuda_version: probe.cuda,
        requirements_sha256: file_sha256(requirements)?,
        constraints_sha256: file_sha256(constraints)?,
    };
    fs::write(
        staging.join("runtime-manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Cannot write PaddleOCR runtime manifest: {error}"))?;

    promote_runtime(&paths.install_dir, staging)?;
    emit_progress(
        app,
        "completed",
        100,
        &format!("PaddleOCR {} runtime is ready", profile.as_str()),
    );
    log::info!(
        "PaddleOCR managed runtime {} ({}) installed at {}",
        RUNTIME_VERSION,
        profile.as_str(),
        paths.install_dir.display()
    );
    Ok(())
}

fn install_dependencies(
    python: &Path,
    paths: &RuntimePaths,
    profile: RuntimeProfile,
    requirements: &Path,
    constraints: &Path,
    package_indexes: &[String],
    app: &AppHandle,
) -> Result<(), String> {
    if profile == RuntimeProfile::Cuda126 {
        emit_progress(
            app,
            "installing",
            40,
            "Installing the PaddlePaddle CUDA 12.6 runtime from the official CUDA repository",
        );
        let mut install = hidden_command(python);
        configure_python_command(&mut install, paths);
        install.args([
            "-I",
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--no-build-isolation",
            "--no-warn-script-location",
            "--progress-bar",
            "raw",
            "--prefer-binary",
            "--timeout",
            "120",
            "--retries",
            "3",
            "--upgrade",
            "--index-url",
            CUDA_PACKAGE_INDEX,
        ]);
        if let Some(extra_index) = package_indexes.first() {
            install.args(["--extra-index-url", extra_index]);
        }
        install
            .arg("--constraint")
            .arg(constraints)
            .arg(format!("paddlepaddle-gpu=={PADDLE_VERSION}"));
        run_install_command(install, app, "paddle-install:progress", "PaddleOCR").map_err(
            |error| {
            format!(
                "PaddlePaddle CUDA {CUDA_VERSION} could not be installed from {CUDA_PACKAGE_INDEX}: {error}"
            )
        },
        )?;
    }

    install_requirements(
        python,
        paths,
        requirements,
        constraints,
        package_indexes,
        app,
        "paddle-install:progress",
        "PaddleOCR",
    )
}

#[allow(clippy::too_many_arguments)]
fn install_requirements(
    python: &Path,
    paths: &RuntimePaths,
    requirements: &Path,
    constraints: &Path,
    package_indexes: &[String],
    app: &AppHandle,
    progress_event: &'static str,
    display_name: &'static str,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for (attempt, index) in package_indexes.iter().enumerate() {
        if attempt > 0 {
            emit_runtime_progress(
                app,
                progress_event,
                "installing",
                40,
                &format!("The package mirror was unavailable. Retrying with backup index: {index}"),
            );
        }
        let mut install = hidden_command(python);
        configure_python_command(&mut install, paths);
        install.args([
            "-I",
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--no-build-isolation",
            "--no-warn-script-location",
            "--progress-bar",
            "raw",
            "--prefer-binary",
            "--timeout",
            "60",
            "--retries",
            "3",
            "--upgrade",
            "--index-url",
            index.as_str(),
            "--constraint",
        ]);
        install
            .arg(constraints)
            .arg("--requirement")
            .arg(requirements);
        match run_install_command(install, app, progress_event, display_name) {
            Ok(()) => return Ok(()),
            Err(error) => {
                log::warn!("{display_name} installation through {index} failed: {error}");
                errors.push(error);
            }
        }
    }
    Err(format!(
        "{display_name} packages could not be installed from either package index: {}",
        errors.join("\n---\n")
    ))
}

pub fn package_index_urls(primary: &str, fallback: &str) -> Vec<String> {
    let primary = package_index_url(primary).unwrap_or(USTC_PYPI_URL);
    let requested_fallback = package_index_url(fallback).unwrap_or(TSINGHUA_PYPI_URL);
    let fallback = if requested_fallback == primary {
        if primary == USTC_PYPI_URL {
            TSINGHUA_PYPI_URL
        } else {
            USTC_PYPI_URL
        }
    } else {
        requested_fallback
    };
    vec![primary.to_string(), fallback.to_string()]
}

fn package_index_url(index: &str) -> Option<&'static str> {
    match index.trim().to_ascii_lowercase().as_str() {
        "ustc" => Some(USTC_PYPI_URL),
        "tsinghua" => Some(TSINGHUA_PYPI_URL),
        "official" => Some(OFFICIAL_PYPI_URL),
        _ => None,
    }
}

fn prepare_python(staging: &Path, bootstrap_wheels: &[PathBuf]) -> Result<(), String> {
    #[cfg(windows)]
    {
        let pth = staging.join("python311._pth");
        let contents = fs::read_to_string(&pth)
            .map_err(|error| format!("Cannot read {}: {error}", pth.display()))?;
        let enabled = contents.replace("#import site", "import site");
        fs::write(&pth, enabled)
            .map_err(|error| format!("Cannot enable Python site packages: {error}"))?;
    }

    let site_packages = staging.join(site_packages_relative_path());
    fs::create_dir_all(&site_packages)
        .map_err(|error| format!("Cannot create Python site-packages: {error}"))?;
    for wheel in bootstrap_wheels {
        extract_zip(wheel, &site_packages)?;
    }
    Ok(())
}

fn probe_runtime(python: &Path, paths: &RuntimePaths) -> Result<RuntimeProbe, String> {
    let mut command = hidden_command(python);
    configure_python_command(&mut command, paths);
    let output = command
        .args([
            "-I",
            "-c",
            "import json,sys,paddle,paddleocr,fitz; print(json.dumps({'python':sys.version.split()[0],'paddle':paddle.__version__,'paddleocr':paddleocr.__version__,'compiled_with_cuda':paddle.is_compiled_with_cuda(),'cuda':paddle.version.cuda() or None}))",
        ])
        .output()
        .map_err(|error| format!("Cannot verify PaddleOCR runtime: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "PaddleOCR verification failed: {}",
            output_error(&output)
        ));
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<RuntimeProbe>(line).ok())
        .ok_or_else(|| "PaddleOCR verification returned no runtime information".to_string())
}

fn runtime_probe_matches_profile(probe: &RuntimeProbe, profile: RuntimeProfile) -> bool {
    probe.compiled_with_cuda == profile.expects_cuda()
        && match profile {
            RuntimeProfile::Cpu => probe.cuda.is_none(),
            RuntimeProfile::Cuda126 => probe
                .cuda
                .as_deref()
                .is_some_and(|version| version.starts_with(CUDA_VERSION)),
        }
}

fn probe_rapid_runtime(python: &Path, paths: &RuntimePaths) -> Result<RapidRuntimeProbe, String> {
    let mut command = hidden_command(python);
    configure_python_command(&mut command, paths);
    let output = command
        .args([
            "-I",
            "-c",
            "import json,sys,fitz,onnxruntime; from importlib.metadata import version; print(json.dumps({'python':sys.version.split()[0],'rapidocr':version('rapidocr'),'onnxruntime':onnxruntime.__version__,'pymupdf':fitz.VersionBind,'providers':onnxruntime.get_available_providers()}))",
        ])
        .output()
        .map_err(|error| format!("Cannot verify RapidOCR runtime: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "RapidOCR verification failed: {}",
            output_error(&output)
        ));
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<RapidRuntimeProbe>(line).ok())
        .ok_or_else(|| "RapidOCR verification returned no runtime information".to_string())
}

fn rapid_probe_matches_profile(probe: &RapidRuntimeProbe, profile: RapidRuntimeProfile) -> bool {
    probe.python.starts_with(PYTHON_VERSION)
        && probe.rapidocr == RAPIDOCR_VERSION
        && probe.onnxruntime == RAPID_ORT_VERSION
        && probe.pymupdf == PYMUPDF_VERSION
        && probe
            .providers
            .iter()
            .any(|provider| provider == profile.expected_provider())
        && probe
            .providers
            .iter()
            .any(|provider| provider == "CPUExecutionProvider")
}

fn run_install_command(
    mut command: Command,
    app: &AppHandle,
    progress_event: &'static str,
    display_name: &'static str,
) -> Result<(), String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start {display_name} dependency installer: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{display_name} installer stdout is unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{display_name} installer stderr is unavailable"))?;
    let (sender, receiver) = mpsc::channel::<(bool, String)>();
    let stdout_sender = sender.clone();
    let stdout_thread = std::thread::spawn(move || {
        forward_install_output(stdout, false, stdout_sender);
    });
    let stderr_thread = std::thread::spawn(move || {
        forward_install_output(stderr, true, sender);
    });
    let mut output_tail = VecDeque::with_capacity(80);
    let mut progress = 40;

    let status = loop {
        match receiver.recv_timeout(Duration::from_millis(150)) {
            Ok((is_error, line)) => record_install_line(
                app,
                progress_event,
                display_name,
                is_error,
                line,
                &mut output_tail,
                &mut progress,
            ),
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
    };
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    while let Ok((is_error, line)) = receiver.try_recv() {
        record_install_line(
            app,
            progress_event,
            display_name,
            is_error,
            line,
            &mut output_tail,
            &mut progress,
        );
    }
    if !status.success() {
        return Err(format!(
            "{display_name} dependency installation exited with {status}: {}",
            output_tail.into_iter().collect::<Vec<_>>().join("\n")
        ));
    }
    Ok(())
}

fn forward_install_output<R: Read>(
    reader: R,
    is_error: bool,
    sender: mpsc::Sender<(bool, String)>,
) {
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) => break,
            Ok(_) => {
                while matches!(bytes.last(), Some(b'\n' | b'\r')) {
                    bytes.pop();
                }
                let line = String::from_utf8_lossy(&bytes).into_owned();
                let _ = sender.send((is_error, line));
            }
            Err(error) => {
                log::warn!("Python installer output pipe could not be read: {error}");
                break;
            }
        }
    }
}

fn record_install_line(
    app: &AppHandle,
    progress_event: &'static str,
    display_name: &'static str,
    is_error: bool,
    line: String,
    output_tail: &mut VecDeque<String>,
    progress: &mut u8,
) {
    let mut line = line.trim().to_string();
    if line.is_empty() {
        return;
    }
    let next_progress = install_line_progress(&line);
    if let Some((current, total)) = raw_download_progress(&line) {
        if next_progress <= *progress && current < total {
            return;
        }
        line = format_download_progress(current, total);
    }
    if is_error {
        log::warn!("{display_name} installer: {line}");
    } else {
        log::info!("{display_name} installer: {line}");
    }
    if output_tail.len() == 80 {
        output_tail.pop_front();
    }
    output_tail.push_back(line.clone());
    *progress = (*progress).max(next_progress);
    emit_runtime_progress(
        app,
        progress_event,
        "installing",
        *progress,
        &line.chars().take(300).collect::<String>(),
    );
}

fn install_line_progress(line: &str) -> u8 {
    if let Some((current, total)) = raw_download_progress(line) {
        if total == 0 {
            return 56;
        }
        return 56 + ((current.saturating_mul(18) / total).min(18) as u8);
    }
    if line.starts_with("Successfully installed") {
        85
    } else if line.starts_with("Installing collected packages") {
        78
    } else if line.contains("Building wheel") || line.contains("Preparing metadata") {
        68
    } else if line.trim_start().starts_with("Downloading") {
        56
    } else if line.starts_with("Collecting") {
        46
    } else {
        40
    }
}

fn raw_download_progress(line: &str) -> Option<(u64, u64)> {
    let values = line.strip_prefix("Progress ")?;
    let (current, total) = values.split_once(" of ")?;
    Some((current.parse().ok()?, total.parse().ok()?))
}

fn format_download_progress(current: u64, total: u64) -> String {
    if total == 0 {
        return format!(
            "Downloading package: {:.1} MB",
            current as f64 / 1_000_000.0
        );
    }
    let percent = current.saturating_mul(100) / total;
    format!(
        "Downloading package: {:.1} / {:.1} MB ({}%)",
        current as f64 / 1_000_000.0,
        total as f64 / 1_000_000.0,
        percent.min(100)
    )
}

fn promote_runtime(final_dir: &Path, staging: &Path) -> Result<(), String> {
    let backup = final_dir.with_extension(format!("backup-{}", uuid::Uuid::new_v4()));
    let had_existing = final_dir.exists();
    if had_existing {
        fs::rename(final_dir, &backup)
            .map_err(|error| format!("Cannot replace the previous managed OCR runtime: {error}"))?;
    }
    if let Err(error) = fs::rename(staging, final_dir) {
        if had_existing {
            let _ = fs::rename(&backup, final_dir);
        }
        return Err(format!("Cannot activate the managed OCR runtime: {error}"));
    }
    if had_existing {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

fn cleanup_interrupted_installations(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(".installing-")
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn extract_zip(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive_path)
        .map_err(|error| format!("Cannot open {}: {error}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Invalid ZIP archive {}: {error}", archive_path.display()))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe path in {}", archive_path.display()))?
            .to_path_buf();
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut target = File::create(&output).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut target).map_err(|error| error.to_string())?;
        target.flush().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn extract_tar_gz(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive_path)
        .map_err(|error| format!("Cannot open {}: {error}", archive_path.display()))?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| error.to_string())?;
    for entry in entries {
        let mut entry = entry.map_err(|error| error.to_string())?;
        entry
            .unpack_in(destination)
            .map_err(|error| format!("Cannot extract Python runtime: {error}"))?;
    }
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<(), String> {
    let actual = file_sha256(path)?;
    if actual != expected {
        return Err(format!(
            "Security check failed for {}: expected SHA-256 {expected}, got {actual}",
            path.display()
        ));
    }
    Ok(())
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Cannot open {} for hashing: {error}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn embedded_rapid_wheelhouse(
    app: &AppHandle,
    profile: RapidRuntimeProfile,
    requirements: &Path,
    constraints: &Path,
) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(
            resource_dir
                .join("resources")
                .join("rapidocr-runtime")
                .join(profile.as_str()),
        );
        candidates.push(
            resource_dir
                .join("rapidocr-runtime")
                .join(profile.as_str()),
        );
    }
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("rapidocr-runtime")
            .join(profile.as_str()),
    );
    let wheelhouse = candidates
        .into_iter()
        .find(|path| path.join("wheelhouse-manifest.json").is_file())
        .ok_or_else(|| {
            format!(
                "Embedded RapidOCR {} wheelhouse was not found. Rebuild the release with npm run prepare:rapidocr-runtime.",
                profile.as_str()
            )
        })?;
    verify_rapid_wheelhouse(profile, requirements, constraints, &wheelhouse)?;
    Ok(wheelhouse)
}

fn verify_rapid_wheelhouse(
    profile: RapidRuntimeProfile,
    requirements: &Path,
    constraints: &Path,
    wheelhouse: &Path,
) -> Result<String, String> {
    let manifest_path = wheelhouse.join("wheelhouse-manifest.json");
    let manifest_contents = fs::read_to_string(&manifest_path).map_err(|error| {
        format!(
            "Cannot read embedded RapidOCR wheelhouse manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    let manifest: EmbeddedRapidWheelhouseManifest = serde_json::from_str(&manifest_contents)
        .map_err(|error| format!("Invalid embedded RapidOCR wheelhouse manifest: {error}"))?;
    if manifest.version != RAPID_WHEELHOUSE_VERSION
        || manifest.profile != profile.as_str()
        || !manifest.python_version.starts_with(PYTHON_VERSION)
        || manifest.requirements_sha256 != file_sha256(requirements)?
        || manifest.constraints_sha256 != file_sha256(constraints)?
        || manifest.files.is_empty()
    {
        return Err(format!(
            "Embedded RapidOCR {} wheelhouse does not match runtime version {RAPID_RUNTIME_VERSION}",
            profile.as_str()
        ));
    }

    let mut names = HashSet::new();
    for file in &manifest.files {
        let relative = Path::new(&file.name);
        if !file.name.ends_with(".whl")
            || relative.components().count() != 1
            || !names.insert(file.name.as_str())
        {
            return Err(format!(
                "Unsafe or duplicate wheel name in RapidOCR manifest: {}",
                file.name
            ));
        }
        let path = wheelhouse.join(relative);
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Embedded RapidOCR wheel {} is missing: {error}", path.display()))?;
        if !metadata.is_file() || metadata.len() != file.size {
            return Err(format!(
                "Embedded RapidOCR wheel {} has an unexpected size",
                path.display()
            ));
        }
        let actual = file_sha256(&path)?;
        if actual != file.sha256 {
            return Err(format!(
                "Security check failed for embedded RapidOCR wheel {}: expected {}, got {actual}",
                path.display(),
                file.sha256
            ));
        }
    }
    file_sha256(&manifest_path)
}

fn runtime_resource(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(
            resource_dir
                .join("resources")
                .join("paddle-runtime")
                .join(name),
        );
        candidates.push(resource_dir.join("paddle-runtime").join(name));
    }
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("paddle-runtime")
            .join(name),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| format!("Bundled Python runtime resource '{name}' was not found"))
}

fn emit_progress(app: &AppHandle, stage: &'static str, progress: u8, message: &str) {
    emit_runtime_progress(app, "paddle-install:progress", stage, progress, message);
}

fn emit_runtime_progress(
    app: &AppHandle,
    event: &'static str,
    stage: &'static str,
    progress: u8,
    message: &str,
) {
    let _ = app.emit(
        event,
        RuntimeInstallProgress {
            stage,
            progress,
            message: message.to_string(),
        },
    );
}

fn output_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let text = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    text.chars()
        .rev()
        .take(4_000)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn bundle_spec() -> Result<BundleSpec, String> {
    Ok(BundleSpec {
        archive_name: "python-3.11.9-embed-amd64.zip",
        archive_sha256: "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b",
        kind: ArchiveKind::Zip,
    })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn bundle_spec() -> Result<BundleSpec, String> {
    Ok(BundleSpec {
        archive_name: "cpython-3.11.12+20250517-aarch64-apple-darwin-install_only_stripped.tar.gz",
        archive_sha256: "82ffd1ecf04d447580b40d5c5abb5bf12c6838b009e1e75e92dae05debfc9986",
        kind: ArchiveKind::TarGz,
    })
}

#[cfg(not(any(
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64")
)))]
fn bundle_spec() -> Result<BundleSpec, String> {
    Err(unsupported_message())
}

#[cfg(windows)]
fn python_relative_path() -> &'static Path {
    Path::new("python.exe")
}

#[cfg(target_os = "macos")]
fn python_relative_path() -> &'static Path {
    Path::new("python/bin/python3")
}

#[cfg(not(any(windows, target_os = "macos")))]
fn python_relative_path() -> &'static Path {
    Path::new("python/bin/python3")
}

#[cfg(windows)]
fn site_packages_relative_path() -> &'static Path {
    Path::new("Lib/site-packages")
}

#[cfg(not(windows))]
fn site_packages_relative_path() -> &'static Path {
    Path::new("python/lib/python3.11/site-packages")
}

pub fn unsupported_message() -> String {
    format!(
        "The managed PaddleOCR runtime is not available for {}/{}",
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

pub fn unsupported_profile_message(profile: RuntimeProfile) -> String {
    if profile == RuntimeProfile::Cuda126 {
        format!(
            "The managed PaddleOCR CUDA {CUDA_VERSION} runtime is only available on Windows x64"
        )
    } else {
        unsupported_message()
    }
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

#[cfg(test)]
mod tests {
    use super::{
        configure_python_command, file_sha256, forward_install_output, install_line_progress,
        install_supported, package_index_urls, profile_install_supported, promote_runtime,
        rapid_probe_matches_profile, rapid_runtime_profile, raw_download_progress,
        runtime_probe_matches_profile, verify_rapid_wheelhouse, RapidRuntimeProbe,
        RapidRuntimeProfile, RuntimePaths, RuntimeProbe, RuntimeProfile, RAPIDOCR_VERSION,
        RAPID_ORT_VERSION, RAPID_RUNTIME_VERSION, RUNTIME_VERSION,
    };

    #[test]
    fn hashes_runtime_assets_with_sha256() {
        let path =
            std::env::temp_dir().join(format!("xdocuments-runtime-hash-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"runtime").unwrap();
        assert_eq!(
            file_sha256(&path).unwrap(),
            "d92c6a81b2ff50096bcda80885427d1f59a25b5f483f7055523504925d16ab23"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn runtime_version_is_explicit() {
        assert_eq!(RUNTIME_VERSION, "3");
        assert_eq!(RuntimeProfile::Cpu.directory_name(), "cpu-v3");
        assert_eq!(RuntimeProfile::Cuda126.directory_name(), "cu126-v3");
        if cfg!(all(target_os = "windows", target_arch = "x86_64"))
            || cfg!(all(target_os = "macos", target_arch = "aarch64"))
        {
            assert!(install_supported());
        }
        assert_eq!(
            profile_install_supported(RuntimeProfile::Cuda126),
            cfg!(all(target_os = "windows", target_arch = "x86_64"))
        );
    }

    #[test]
    fn runtime_probe_requires_the_expected_cuda_profile() {
        let cpu = RuntimeProbe {
            python: "3.11.9".to_string(),
            paddle: "3.3.1".to_string(),
            paddleocr: "3.3.1".to_string(),
            compiled_with_cuda: false,
            cuda: None,
        };
        let cuda126 = RuntimeProbe {
            compiled_with_cuda: true,
            cuda: Some("12.6.77".to_string()),
            ..cpu.clone()
        };
        let cuda118 = RuntimeProbe {
            cuda: Some("11.8".to_string()),
            ..cuda126.clone()
        };

        assert!(runtime_probe_matches_profile(&cpu, RuntimeProfile::Cpu));
        assert!(runtime_probe_matches_profile(
            &cuda126,
            RuntimeProfile::Cuda126
        ));
        assert!(!runtime_probe_matches_profile(
            &cuda118,
            RuntimeProfile::Cuda126
        ));
        assert!(!runtime_probe_matches_profile(
            &cuda126,
            RuntimeProfile::Cpu
        ));
    }

    #[test]
    fn rapid_runtime_profile_and_versions_are_explicit() {
        assert_eq!(RAPID_RUNTIME_VERSION, "2");
        assert_eq!(RAPIDOCR_VERSION, "3.9.2");
        assert_eq!(RAPID_ORT_VERSION, "1.24.4");
        assert_eq!(
            RapidRuntimeProfile::DirectMl.directory_name(),
            "directml-v2"
        );
        assert_eq!(RapidRuntimeProfile::CoreMl.directory_name(), "coreml-v2");
        if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            assert_eq!(
                rapid_runtime_profile().unwrap(),
                RapidRuntimeProfile::DirectMl
            );
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            assert_eq!(
                rapid_runtime_profile().unwrap(),
                RapidRuntimeProfile::CoreMl
            );
        } else {
            assert!(rapid_runtime_profile().is_err());
        }
    }

    #[test]
    fn rapid_runtime_probe_requires_the_platform_provider_and_cpu_fallback() {
        let directml = RapidRuntimeProbe {
            python: "3.11.9".to_string(),
            rapidocr: "3.9.2".to_string(),
            onnxruntime: "1.24.4".to_string(),
            pymupdf: "1.24.14".to_string(),
            providers: vec![
                "DmlExecutionProvider".to_string(),
                "CPUExecutionProvider".to_string(),
            ],
        };
        assert!(rapid_probe_matches_profile(
            &directml,
            RapidRuntimeProfile::DirectMl
        ));

        let cpu_only = RapidRuntimeProbe {
            providers: vec!["CPUExecutionProvider".to_string()],
            ..directml.clone()
        };
        assert!(!rapid_probe_matches_profile(
            &cpu_only,
            RapidRuntimeProfile::DirectMl
        ));

        let directml_without_cpu = RapidRuntimeProbe {
            providers: vec!["DmlExecutionProvider".to_string()],
            ..directml
        };
        assert!(!rapid_probe_matches_profile(
            &directml_without_cpu,
            RapidRuntimeProfile::DirectMl
        ));
    }

    #[test]
    fn embedded_rapid_wheelhouse_rejects_tampered_wheels() {
        let root = std::env::temp_dir().join(format!(
            "xdocuments-rapid-wheelhouse-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let requirements = root.join("requirements.txt");
        let constraints = root.join("constraints.txt");
        let wheel = root.join("package-1.0-py3-none-any.whl");
        std::fs::write(&requirements, "package==1.0\n").unwrap();
        std::fs::write(&constraints, "package==1.0\n").unwrap();
        std::fs::write(&wheel, b"wheel").unwrap();
        let manifest = serde_json::json!({
            "version": 1,
            "profile": "directml",
            "python_version": "3.11",
            "requirements_sha256": file_sha256(&requirements).unwrap(),
            "constraints_sha256": file_sha256(&constraints).unwrap(),
            "files": [{
                "name": "package-1.0-py3-none-any.whl",
                "size": 5,
                "sha256": file_sha256(&wheel).unwrap()
            }]
        });
        std::fs::write(
            root.join("wheelhouse-manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        assert!(verify_rapid_wheelhouse(
            RapidRuntimeProfile::DirectMl,
            &requirements,
            &constraints,
            &root
        )
        .is_ok());
        std::fs::write(&wheel, b"tampered").unwrap();
        assert!(verify_rapid_wheelhouse(
            RapidRuntimeProfile::DirectMl,
            &requirements,
            &constraints,
            &root
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installation_output_advances_but_never_completes_the_verification_stage() {
        assert_eq!(install_line_progress("Collecting paddleocr"), 46);
        assert_eq!(install_line_progress("  Downloading paddle.whl"), 56);
        assert_eq!(
            raw_download_progress("Progress 298700000 of 579400000"),
            Some((298_700_000, 579_400_000))
        );
        assert_eq!(
            install_line_progress("Progress 298700000 of 579400000"),
            65
        );
        assert_eq!(install_line_progress("Progress 579400000 of 579400000"), 74);
        assert_eq!(install_line_progress("Building wheel for package"), 68);
        assert_eq!(
            install_line_progress("Installing collected packages: paddle"),
            78
        );
        assert_eq!(install_line_progress("Successfully installed paddle"), 85);
    }

    #[test]
    fn installer_output_reader_keeps_draining_after_non_utf8_path_bytes() {
        let output = b"Processing D:\\\xb2\xe2\xca\xd4\\rapidocr.whl\r\nSuccessfully installed rapidocr\r\n";
        let (sender, receiver) = std::sync::mpsc::channel();

        forward_install_output(&output[..], false, sender);
        let lines = receiver.into_iter().collect::<Vec<_>>();

        assert_eq!(lines.len(), 2);
        assert!(!lines[0].0);
        assert!(lines[0].1.starts_with("Processing D:\\"));
        assert!(lines[0].1.ends_with("\\rapidocr.whl"));
        assert_eq!(lines[1].1, "Successfully installed rapidocr");
    }

    #[test]
    fn python_commands_force_utf8_for_the_process_and_its_children() {
        let root = std::path::PathBuf::from("runtime");
        let paths = RuntimePaths {
            install_dir: root.join("install"),
            python: root.join("python.exe"),
            manifest: root.join("manifest.json"),
            model_cache: root.join("models"),
            pip_cache: root.join("pip-cache"),
            root,
        };
        let mut command = std::process::Command::new("python");

        configure_python_command(&mut command, &paths);

        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let env = command
            .get_envs()
            .filter_map(|(key, value)| {
                Some((
                    key.to_string_lossy().into_owned(),
                    value?.to_string_lossy().into_owned(),
                ))
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(args, ["-X", "utf8"]);
        assert_eq!(env.get("PYTHONUTF8").map(String::as_str), Some("1"));
        assert_eq!(
            env.get("PYTHONIOENCODING").map(String::as_str),
            Some("utf-8:backslashreplace")
        );
    }

    #[test]
    fn package_indexes_default_to_ustc_then_tsinghua() {
        assert_eq!(
            package_index_urls("", ""),
            vec![
                "https://mirrors.ustc.edu.cn/pypi/simple",
                "https://pypi.tuna.tsinghua.edu.cn/simple"
            ]
        );
        assert_eq!(
            package_index_urls("tsinghua", "official"),
            vec![
                "https://pypi.tuna.tsinghua.edu.cn/simple",
                "https://pypi.org/simple"
            ]
        );
        assert_eq!(
            package_index_urls("ustc", "ustc"),
            vec![
                "https://mirrors.ustc.edu.cn/pypi/simple",
                "https://pypi.tuna.tsinghua.edu.cn/simple"
            ]
        );
    }

    #[test]
    fn promotes_a_staged_runtime_over_an_existing_version() {
        let root = std::env::temp_dir().join(format!(
            "xdocuments-runtime-promote-{}",
            uuid::Uuid::new_v4()
        ));
        let final_dir = root.join("cpu-v3");
        let staging = root.join(".installing-test");
        std::fs::create_dir_all(&final_dir).unwrap();
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(final_dir.join("state"), "old").unwrap();
        std::fs::write(staging.join("state"), "new").unwrap();

        promote_runtime(&final_dir, &staging).unwrap();

        assert_eq!(
            std::fs::read_to_string(final_dir.join("state")).unwrap(),
            "new"
        );
        assert!(!staging.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
