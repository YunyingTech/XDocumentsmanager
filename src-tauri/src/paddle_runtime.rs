use std::collections::VecDeque;
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

pub const RUNTIME_VERSION: &str = "2";
const PYTHON_VERSION: &str = "3.11";
const PADDLE_VERSION: &str = "3.3.1";
const PADDLEOCR_VERSION: &str = "3.3.1";
const PIP_WHEEL: &str = "pip-25.1.1-py3-none-any.whl";
const PIP_WHEEL_SHA256: &str = "2913a38a2abf4ea6b64ab507bd9e967f3b53dc1ede74b01b0931e1ce548751af";
const SETUPTOOLS_WHEEL: &str = "setuptools-80.9.0-py3-none-any.whl";
const SETUPTOOLS_WHEEL_SHA256: &str =
    "062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922";
const WHEEL_WHEEL: &str = "wheel-0.45.1-py3-none-any.whl";
const WHEEL_WHEEL_SHA256: &str = "708e7481cc80179af0e556bbf0cc00b8444c7321e2700b8d8580231d13017248";

static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
pub struct PaddleInstallProgress {
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
    python_version: String,
    paddle_version: String,
    paddleocr_version: String,
    requirements_sha256: String,
    constraints_sha256: String,
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
    pub fn for_app(app: &AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?
            .join("paddle-runtime");
        let install_dir = root.join(format!("v{RUNTIME_VERSION}"));
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

    pub fn is_ready(&self) -> bool {
        if !self.python.is_file() || !self.manifest.is_file() {
            return false;
        }
        fs::read_to_string(&self.manifest)
            .ok()
            .and_then(|contents| serde_json::from_str::<RuntimeManifest>(&contents).ok())
            .is_some_and(|manifest| {
                manifest.runtime_version == RUNTIME_VERSION
                    && manifest.python_version.starts_with(PYTHON_VERSION)
                    && manifest.paddle_version == PADDLE_VERSION
                    && manifest.paddleocr_version == PADDLEOCR_VERSION
                    && manifest.requirements_sha256.len() == 64
                    && manifest.constraints_sha256.len() == 64
            })
    }
}

pub fn install_supported() -> bool {
    cfg!(all(target_os = "windows", target_arch = "x86_64"))
        || cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

pub fn configure_python_command(command: &mut Command, paths: &RuntimePaths) {
    command
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
    requirements: &Path,
    constraints: &Path,
) -> Result<RuntimePaths, String> {
    if !install_supported() {
        return Err(unsupported_message());
    }
    let lock = INSTALL_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let paths = RuntimePaths::for_app(app)?;
    if paths.is_ready() && probe_versions(&paths.python, &paths).is_ok() {
        emit_progress(
            app,
            "completed",
            100,
            "PaddleOCR runtime is already installed",
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

    let result = install_into(app, requirements, constraints, &paths, &staging);
    if let Err(error) = &result {
        let _ = fs::remove_dir_all(&staging);
        emit_progress(app, "failed", 100, error);
        log::error!("PaddleOCR managed runtime installation failed: {error}");
    }
    result.map(|_| paths)
}

fn install_into(
    app: &AppHandle,
    requirements: &Path,
    constraints: &Path,
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
    install_dependencies(&staging_python, paths, requirements, constraints, app)?;

    emit_progress(app, "verifying", 90, "Verifying PaddleOCR components");
    let versions = probe_versions(&staging_python, paths)?;
    if !versions.0.starts_with(PYTHON_VERSION)
        || versions.1 != PADDLE_VERSION
        || versions.2 != PADDLEOCR_VERSION
    {
        return Err(format!(
            "PaddleOCR version verification failed: expected Python {PYTHON_VERSION}, PaddlePaddle {PADDLE_VERSION}, PaddleOCR {PADDLEOCR_VERSION}; got Python {}, PaddlePaddle {}, PaddleOCR {}",
            versions.0, versions.1, versions.2
        ));
    }
    let manifest = RuntimeManifest {
        runtime_version: RUNTIME_VERSION.to_string(),
        python_version: versions.0,
        paddle_version: versions.1,
        paddleocr_version: versions.2,
        requirements_sha256: file_sha256(requirements)?,
        constraints_sha256: file_sha256(constraints)?,
    };
    fs::write(
        staging.join("runtime-manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Cannot write PaddleOCR runtime manifest: {error}"))?;

    promote_runtime(&paths.install_dir, staging)?;
    emit_progress(app, "completed", 100, "PaddleOCR is ready");
    log::info!(
        "PaddleOCR managed runtime {} installed at {}",
        RUNTIME_VERSION,
        paths.install_dir.display()
    );
    Ok(())
}

fn install_dependencies(
    python: &Path,
    paths: &RuntimePaths,
    requirements: &Path,
    constraints: &Path,
    app: &AppHandle,
) -> Result<(), String> {
    let indexes = [
        "https://pypi.tuna.tsinghua.edu.cn/simple",
        "https://pypi.org/simple",
    ];
    let mut errors = Vec::new();
    for (attempt, index) in indexes.iter().enumerate() {
        if attempt > 0 {
            emit_progress(
                app,
                "installing",
                40,
                "The package mirror was unavailable. Retrying with the official Python index.",
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
            "--prefer-binary",
            "--timeout",
            "60",
            "--retries",
            "3",
            "--upgrade",
            "--index-url",
            index,
            "--constraint",
        ]);
        install
            .arg(constraints)
            .arg("--requirement")
            .arg(requirements);
        match run_install_command(install, app) {
            Ok(()) => return Ok(()),
            Err(error) => {
                log::warn!("PaddleOCR installation through {index} failed: {error}");
                errors.push(error);
            }
        }
    }
    Err(format!(
        "PaddleOCR packages could not be installed from either package index: {}",
        errors.join("\n---\n")
    ))
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

fn probe_versions(python: &Path, paths: &RuntimePaths) -> Result<(String, String, String), String> {
    let mut command = hidden_command(python);
    configure_python_command(&mut command, paths);
    let output = command
        .args([
            "-I",
            "-c",
            "import json,sys,paddle,paddleocr,fitz; print(json.dumps({'python':sys.version.split()[0],'paddle':paddle.__version__,'paddleocr':paddleocr.__version__}))",
        ])
        .output()
        .map_err(|error| format!("Cannot verify PaddleOCR runtime: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "PaddleOCR verification failed: {}",
            output_error(&output)
        ));
    }
    let value = String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .ok_or_else(|| "PaddleOCR verification returned no version information".to_string())?;
    let get = |name: &str| {
        value
            .get(name)
            .and_then(|item| item.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("PaddleOCR verification omitted {name}"))
    };
    Ok((get("python")?, get("paddle")?, get("paddleocr")?))
}

fn run_install_command(mut command: Command, app: &AppHandle) -> Result<(), String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start PaddleOCR dependency installer: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "PaddleOCR installer stdout is unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "PaddleOCR installer stderr is unavailable".to_string())?;
    let (sender, receiver) = mpsc::channel::<(bool, String)>();
    let stdout_sender = sender.clone();
    let stdout_thread = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = stdout_sender.send((false, line));
        }
    });
    let stderr_thread = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = sender.send((true, line));
        }
    });
    let mut output_tail = VecDeque::with_capacity(80);
    let mut progress = 40;

    let status = loop {
        match receiver.recv_timeout(Duration::from_millis(150)) {
            Ok((is_error, line)) => {
                record_install_line(app, is_error, line, &mut output_tail, &mut progress)
            }
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
        record_install_line(app, is_error, line, &mut output_tail, &mut progress);
    }
    if !status.success() {
        return Err(format!(
            "PaddleOCR dependency installation exited with {status}: {}",
            output_tail.into_iter().collect::<Vec<_>>().join("\n")
        ));
    }
    Ok(())
}

fn record_install_line(
    app: &AppHandle,
    is_error: bool,
    line: String,
    output_tail: &mut VecDeque<String>,
    progress: &mut u8,
) {
    let line = line.trim().to_string();
    if line.is_empty() {
        return;
    }
    if is_error {
        log::warn!("PaddleOCR installer: {line}");
    } else {
        log::info!("PaddleOCR installer: {line}");
    }
    if output_tail.len() == 80 {
        output_tail.pop_front();
    }
    output_tail.push_back(line.clone());
    *progress = (*progress).max(install_line_progress(&line));
    emit_progress(
        app,
        "installing",
        *progress,
        &line.chars().take(300).collect::<String>(),
    );
}

fn install_line_progress(line: &str) -> u8 {
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

fn promote_runtime(final_dir: &Path, staging: &Path) -> Result<(), String> {
    let backup = final_dir.with_extension(format!("backup-{}", uuid::Uuid::new_v4()));
    let had_existing = final_dir.exists();
    if had_existing {
        fs::rename(final_dir, &backup)
            .map_err(|error| format!("Cannot replace the previous PaddleOCR runtime: {error}"))?;
    }
    if let Err(error) = fs::rename(staging, final_dir) {
        if had_existing {
            let _ = fs::rename(&backup, final_dir);
        }
        return Err(format!("Cannot activate the PaddleOCR runtime: {error}"));
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
        .ok_or_else(|| format!("Bundled PaddleOCR runtime resource '{name}' was not found"))
}

fn emit_progress(app: &AppHandle, stage: &'static str, progress: u8, message: &str) {
    let _ = app.emit(
        "paddle-install:progress",
        PaddleInstallProgress {
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
        file_sha256, install_line_progress, install_supported, promote_runtime, RUNTIME_VERSION,
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
        assert_eq!(RUNTIME_VERSION, "2");
        if cfg!(all(target_os = "windows", target_arch = "x86_64"))
            || cfg!(all(target_os = "macos", target_arch = "aarch64"))
        {
            assert!(install_supported());
        }
    }

    #[test]
    fn installation_output_advances_but_never_completes_the_verification_stage() {
        assert_eq!(install_line_progress("Collecting paddleocr"), 46);
        assert_eq!(install_line_progress("  Downloading paddle.whl"), 56);
        assert_eq!(install_line_progress("Building wheel for package"), 68);
        assert_eq!(
            install_line_progress("Installing collected packages: paddle"),
            78
        );
        assert_eq!(install_line_progress("Successfully installed paddle"), 85);
    }

    #[test]
    fn promotes_a_staged_runtime_over_an_existing_version() {
        let root = std::env::temp_dir().join(format!(
            "xdocuments-runtime-promote-{}",
            uuid::Uuid::new_v4()
        ));
        let final_dir = root.join("v2");
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
