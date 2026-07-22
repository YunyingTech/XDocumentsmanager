use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const DEFAULT_LINES: usize = 500;
const MAX_LINES: usize = 2_000;
const MAX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct RuntimeLogSnapshot {
    source: String,
    path: String,
    lines: Vec<String>,
    updated_at: Option<u64>,
}

#[tauri::command]
pub fn get_runtime_logs(
    source: String,
    max_lines: Option<usize>,
    app: AppHandle,
) -> Result<RuntimeLogSnapshot, String> {
    let path = log_path(&app, &source)?;
    let max_lines = max_lines.unwrap_or(DEFAULT_LINES).clamp(1, MAX_LINES);
    let lines = tail_lines(&path, max_lines)?;
    let updated_at = std::fs::metadata(&path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);

    Ok(RuntimeLogSnapshot {
        source,
        path: path.to_string_lossy().to_string(),
        lines,
        updated_at,
    })
}

fn log_path(app: &AppHandle, source: &str) -> Result<PathBuf, String> {
    match source {
        "application" => app
            .path()
            .app_log_dir()
            .map(|directory| directory.join("XDocuments.log"))
            .map_err(|error| error.to_string()),
        "elasticsearch" => {
            let directory = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?
                .join("elasticsearch")
                .join("logs");
            let primary = directory.join("xdocuments.log");
            if primary.is_file() {
                Ok(primary)
            } else {
                Ok(directory.join("elasticsearch-stdout.log"))
            }
        }
        _ => Err("Unknown runtime log source".to_string()),
    }
}

fn tail_lines(path: &Path, max_lines: usize) -> Result<Vec<String>, String> {
    if !path.is_file() {
        return Ok(Vec::new());
    }

    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let start = length.saturating_sub(MAX_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity((length - start) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;

    if start > 0 {
        if let Some(first_newline) = bytes.iter().position(|byte| *byte == b'\n') {
            bytes.drain(..=first_newline);
        }
    }

    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text
        .lines()
        .rev()
        .take(max_lines)
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect::<Vec<_>>();
    lines.reverse();
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::tail_lines;

    #[test]
    fn reads_only_the_requested_log_tail() {
        let path =
            std::env::temp_dir().join(format!("xdocuments-log-tail-{}.log", uuid::Uuid::new_v4()));
        std::fs::write(&path, "one\ntwo\nthree\nfour\n").unwrap();
        assert_eq!(tail_lines(&path, 2).unwrap(), vec!["three", "four"]);
        std::fs::remove_file(path).unwrap();
    }
}
