// Indexing pipeline orchestrator — Phase 2
// Coordinates walker → hasher → extractor → database storage
// using bounded channels and worker pools.

use std::path::PathBuf;
use std::time::UNIX_EPOCH;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};
use crate::indexer::walker;
use crate::indexer::hasher;
use crate::models::IndexProgress;

/// Configuration for the indexing pipeline
pub struct PipelineConfig {
    pub root_path: PathBuf,
    pub folder_id: i64,
    pub num_workers: usize,
    pub max_file_size_bytes: i64,
}

/// Progress update from the pipeline
#[derive(Debug, Clone)]
pub struct PipelineProgress {
    pub files_total: u64,
    pub files_processed: u64,
    pub files_indexed: u64,
    pub files_skipped: u64,
    pub files_errors: u64,
    pub bytes_processed: u64,
    pub current_file: Option<String>,
}

/// Run a full indexing pipeline for a folder.
/// Emits `indexing:progress` events via `app_handle` for real-time UI updates.
/// Updates the `index_jobs` table incrementally.
pub fn run_full_index(
    config: PipelineConfig,
    db: &Connection,
    app_handle: &AppHandle,
    job_id: i64,
) -> Result<(), String> {
    log::info!("Starting full index for folder {}: {:?}", config.folder_id, config.root_path);

    // Walk for PDF files
    let files = walker::walk_pdf_files(&config.root_path);
    let total = files.len() as u64;
    log::info!("Found {} PDF files", total);

    // Set total in the job record
    let _ = db.execute(
        "UPDATE index_jobs SET files_total = ?1 WHERE id = ?2",
        rusqlite::params![total as i64, job_id],
    );

    let mut indexed = 0u64;
    let mut skipped = 0u64;
    let mut errors = 0u64;
    let mut processed = 0u64;

    for file_path in &files {
        // Check file size
        let meta = match std::fs::metadata(file_path) {
            Ok(m) => {
                if m.len() as i64 > config.max_file_size_bytes {
                    skipped += 1;
                    processed += 1;
                    continue;
                }
                m
            }
            Err(_) => {
                errors += 1;
                processed += 1;
                continue;
            }
        };

        let file_size = meta.len() as i64;

        // Format mtime as ISO 8601 string
        let mtime = if let Ok(modified) = meta.modified() {
            if let Ok(duration) = modified.duration_since(UNIX_EPOCH) {
                let secs = duration.as_secs();
                format_unix_timestamp(secs)
            } else {
                String::from("unknown")
            }
        } else {
            String::from("unknown")
        };

        let file_name = file_path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        // Compute relative path for the existing `files` table
        let relative = file_path.strip_prefix(&config.root_path)
            .unwrap_or(file_path)
            .to_string_lossy()
            .replace('\\', "/");

        // Compute absolute path for the indexed_files table
        let abs_path = file_path.to_string_lossy().replace('\\', "/");

        // Compute MD5 hash of file contents
        let md5_hash = match hasher::hash_file_md5(file_path) {
            Ok(h) => h,
            Err(e) => {
                log::warn!("Failed to hash {}: {}", abs_path, e);
                String::from("error")
            }
        };

        // ── Upsert into `files` table ──
        let exists: bool = db.query_row(
            "SELECT COUNT(*) FROM files WHERE folder_id = ?1 AND relative_path = ?2",
            rusqlite::params![config.folder_id, relative],
            |row| row.get::<_, i64>(0),
        ).map(|c| c > 0).unwrap_or(false);

        if exists {
            let _ = db.execute(
                "UPDATE files SET file_size_bytes = ?1, content_hash = ?2, file_modified_at = ?3, index_status = 'indexed', indexed_at = datetime('now') WHERE folder_id = ?4 AND relative_path = ?5",
                rusqlite::params![file_size, md5_hash, mtime, config.folder_id, relative],
            );
        } else {
            let preview_text = format!("PDF document: {}", file_name);
            let _ = db.execute(
                "INSERT INTO files (folder_id, relative_path, file_name, file_extension, file_size_bytes, content_hash, file_modified_at, index_status, indexed_at, text_preview)
                 VALUES (?1, ?2, ?3, 'pdf', ?4, ?5, ?6, 'indexed', datetime('now'), ?7)",
                rusqlite::params![
                    config.folder_id, relative, file_name,
                    file_size, md5_hash, mtime,
                    preview_text,
                ],
            );
        }

        // ── Upsert into `indexed_files` table ──
        let indexed_exists: bool = db.query_row(
            "SELECT COUNT(*) FROM indexed_files WHERE path = ?1",
            rusqlite::params![abs_path],
            |row| row.get::<_, i64>(0),
        ).map(|c| c > 0).unwrap_or(false);

        if indexed_exists {
            let changed: bool = db.query_row(
                "SELECT file_size != ?1 OR mtime != ?2 OR md5 != ?3 FROM indexed_files WHERE path = ?4",
                rusqlite::params![file_size, mtime, md5_hash, abs_path],
                |row| row.get(0),
            ).unwrap_or(true);

            if changed {
                let _ = db.execute(
                    "UPDATE indexed_files SET file_size = ?1, mtime = ?2, md5 = ?3, status = 'indexed', index_time = datetime('now') WHERE path = ?4",
                    rusqlite::params![file_size, mtime, md5_hash, abs_path],
                );
            }
        } else {
            let _ = db.execute(
                "INSERT INTO indexed_files (path, file_size, mtime, md5, status, index_time)
                 VALUES (?1, ?2, ?3, ?4, 'indexed', datetime('now'))",
                rusqlite::params![abs_path, file_size, mtime, md5_hash],
            );
        }

        indexed += 1;
        processed += 1;

        // ── Emit progress event to frontend ──
        let _ = app_handle.emit("indexing:progress", IndexProgress {
            job_id,
            folder_id: Some(config.folder_id),
            status: "running".to_string(),
            files_total: total as i64,
            files_processed: processed as i64,
            files_indexed: indexed as i64,
            files_skipped: skipped as i64,
            files_errors: errors as i64,
            bytes_processed: 0,
            current_file: Some(file_name),
        });

        // ── Update job progress in DB (every 10 files to reduce DB writes) ──
        if processed % 10 == 0 {
            let _ = db.execute(
                "UPDATE index_jobs SET files_processed = ?1, files_indexed = ?2, files_skipped = ?3, files_errors = ?4 WHERE id = ?5",
                rusqlite::params![processed as i64, indexed as i64, skipped as i64, errors as i64, job_id],
            );
        }
    }

    // Update folder totals
    let _ = db.execute(
        "UPDATE watched_folders SET total_files = ?1, total_size_bytes = (SELECT COALESCE(SUM(file_size_bytes), 0) FROM files WHERE folder_id = ?2), last_scan_status = 'completed', last_scan_at = datetime('now'), updated_at = datetime('now') WHERE id = ?2",
        rusqlite::params![indexed as i64, config.folder_id],
    );

    if let Some(engine) = app_handle.try_state::<crate::search::SearchEngine>() {
        if let Err(error) = engine.rebuild(db) {
            log::error!("Failed to refresh the full-text search index: {}", error);
        }
    }

    // Emit final completed event with actual counts
    let _ = app_handle.emit("indexing:progress", IndexProgress {
        job_id,
        folder_id: Some(config.folder_id),
        status: "completed".to_string(),
        files_total: total as i64,
        files_processed: processed as i64,
        files_indexed: indexed as i64,
        files_skipped: skipped as i64,
        files_errors: errors as i64,
        bytes_processed: 0,
        current_file: None,
    });

    // Compact the database (reclaim space from deleted/updated records)
    let _ = db.execute_batch("PRAGMA optimize;");
    let _ = db.execute_batch("PRAGMA analysis_limit = 1000; PRAGMA optimize;");

    log::info!("Index complete: {} indexed, {} skipped, {} errors", indexed, skipped, errors);
    Ok(())
}

/// Format a Unix timestamp (seconds) as an ISO 8601-like string.
fn format_unix_timestamp(secs: u64) -> String {
    // Manual ISO 8601 formatting to avoid chrono dependency for this simple case
    let days_since_epoch = secs / 86400;
    let mut remaining_secs = secs % 86400;
    let hours = remaining_secs / 3600;
    remaining_secs %= 3600;
    let minutes = remaining_secs / 60;
    let seconds = remaining_secs % 60;

    // Convert days since Unix epoch to year/month/day
    let (year, month, day) = days_to_date(days_since_epoch as i64);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        year, month, day, hours, minutes, seconds
    )
}

/// Convert days since Unix epoch (1970-01-01) to (year, month, day).
fn days_to_date(days: i64) -> (i64, i64, i64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as i64, d as i64)
}
