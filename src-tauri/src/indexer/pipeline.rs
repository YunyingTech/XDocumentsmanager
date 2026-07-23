use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use tauri::{AppHandle, Emitter, Manager};

use crate::indexer::{hasher, walker};
use crate::models::IndexProgress;
use crate::search::engine::SearchDocument;
use crate::search::SearchEngine;

const SEARCH_BATCH_SIZE: usize = 250;
const DELETE_BATCH_SIZE: usize = 500;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexMode {
    Incremental,
    Full,
}

impl IndexMode {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("incremental") {
            "incremental" => Ok(Self::Incremental),
            "full" => Ok(Self::Full),
            other => Err(format!("Unsupported index mode: {other}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Incremental => "incremental",
            Self::Full => "full",
        }
    }

    pub fn job_type(self) -> &'static str {
        match self {
            Self::Incremental => "incremental",
            Self::Full => "full_scan",
        }
    }
}

pub struct PipelineConfig {
    pub root_path: PathBuf,
    pub folder_id: i64,
    pub mode: IndexMode,
    pub ocr_after_index: bool,
    pub max_file_size_bytes: i64,
}

#[derive(Debug)]
struct ExistingFile {
    file_size: i64,
    modified_at: String,
    content_hash: String,
    index_status: String,
}

#[derive(Default)]
struct ScanStats {
    processed: u64,
    indexed: u64,
    skipped: u64,
    errors: u64,
    bytes_processed: u64,
    deleted: u64,
}

pub fn run_index(
    config: PipelineConfig,
    db: &Connection,
    app_handle: &AppHandle,
    job_id: i64,
) -> Result<(), String> {
    if !config.root_path.is_dir() {
        return Err(format!(
            "Index root is not an accessible directory: {}",
            config.root_path.display()
        ));
    }

    log::info!(
        "Starting {} index for folder {}: {:?}",
        config.mode.as_str(),
        config.folder_id,
        config.root_path
    );

    db.execute_batch(
        "DROP TABLE IF EXISTS temp.scan_seen;
         CREATE TEMP TABLE scan_seen (
             relative_path TEXT PRIMARY KEY
         ) WITHOUT ROWID;",
    )
    .map_err(|error| error.to_string())?;

    let estimated_total: u64 = db
        .query_row(
            "SELECT COUNT(*) FROM files WHERE folder_id = ?1",
            [config.folder_id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        .max(0) as u64;
    update_job(db, job_id, estimated_total, &ScanStats::default());

    let engine = app_handle.try_state::<SearchEngine>();
    let mut search_upserts = Vec::with_capacity(SEARCH_BATCH_SIZE);
    let mut search_deletes = Vec::with_capacity(SEARCH_BATCH_SIZE);
    let mut stats = ScanStats::default();
    let mut walk_errors = 0u64;
    let mut last_progress = Instant::now() - PROGRESS_INTERVAL;

    for entry in walker::walk_pdf_files(&config.root_path) {
        let file_path = match entry {
            Ok(path) => path,
            Err(error) => {
                walk_errors += 1;
                stats.errors += 1;
                log::warn!("Directory traversal error: {error}");
                continue;
            }
        };
        stats.processed += 1;

        let relative = relative_path(&config.root_path, &file_path);
        db.execute(
            "INSERT OR IGNORE INTO scan_seen (relative_path) VALUES (?1)",
            [&relative],
        )
        .map_err(|error| error.to_string())?;

        let file_name = file_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "unknown.pdf".to_string());
        let metadata = match std::fs::metadata(&file_path) {
            Ok(metadata) => metadata,
            Err(error) => {
                stats.errors += 1;
                log::warn!("Cannot read metadata for {}: {error}", file_path.display());
                emit_if_due(
                    &config,
                    app_handle,
                    db,
                    job_id,
                    estimated_total,
                    &stats,
                    Some(file_name),
                    &mut last_progress,
                );
                continue;
            }
        };
        let file_size = metadata.len() as i64;
        let modified_at = format_system_time(metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH));
        let existing = existing_file(db, config.folder_id, &relative)?;

        if file_size > config.max_file_size_bytes
            && existing.as_ref().is_some_and(|item| {
                item.file_size == file_size
                    && item.modified_at == modified_at
                    && item.index_status == "skipped"
            })
        {
            stats.skipped += 1;
        } else if file_size > config.max_file_size_bytes {
            let file_id = mark_skipped_file(
                db,
                &config,
                &file_path,
                &relative,
                &file_name,
                file_size,
                &modified_at,
                existing.as_ref(),
            )?;
            stats.skipped += 1;
            if config.mode == IndexMode::Incremental {
                search_deletes.push(file_id);
            }
        } else if should_process(config.mode, existing.as_ref(), file_size, &modified_at) {
            match hasher::hash_file_md5(&file_path) {
                Ok(content_hash) => {
                    let content_changed = existing
                        .as_ref()
                        .map_or(true, |item| item.content_hash != content_hash);
                    let file_id = upsert_file(
                        db,
                        &config,
                        &file_path,
                        &relative,
                        &file_name,
                        file_size,
                        &modified_at,
                        &content_hash,
                        content_changed,
                    )?;
                    stats.indexed += 1;
                    stats.bytes_processed += file_size.max(0) as u64;
                    if config.mode == IndexMode::Incremental {
                        search_upserts.push(crate::search::engine::document_for_file(db, file_id)?);
                    }
                }
                Err(error) => {
                    stats.errors += 1;
                    log::warn!("Cannot hash {}: {error}", file_path.display());
                }
            }
        } else {
            stats.skipped += 1;
        }

        if search_upserts.len() + search_deletes.len() >= SEARCH_BATCH_SIZE {
            flush_search_changes(engine.as_deref(), &mut search_upserts, &mut search_deletes);
        }
        emit_if_due(
            &config,
            app_handle,
            db,
            job_id,
            estimated_total,
            &stats,
            Some(file_name),
            &mut last_progress,
        );
    }

    flush_search_changes(engine.as_deref(), &mut search_upserts, &mut search_deletes);

    if walk_errors == 0 {
        stats.deleted = delete_missing_files(db, &config, engine.as_deref(), &mut search_deletes)?;
        flush_search_changes(engine.as_deref(), &mut search_upserts, &mut search_deletes);
    } else {
        log::warn!(
            "Skipped deleted-file reconciliation after {} traversal errors",
            walk_errors
        );
    }

    let (folder_total, folder_bytes): (i64, i64) = db
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(file_size_bytes), 0) FROM files WHERE folder_id = ?1",
            [config.folder_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    db.execute(
        "UPDATE watched_folders
         SET total_files = ?1, total_size_bytes = ?2, last_scan_status = 'completed',
             last_scan_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?3",
        params![folder_total, folder_bytes, config.folder_id],
    )
    .map_err(|error| error.to_string())?;

    if config.mode == IndexMode::Full {
        if let Some(engine) = engine.as_deref() {
            engine.rebuild(db)?;
        }
    }

    update_job(db, job_id, stats.processed, &stats);
    emit_progress(
        &config,
        app_handle,
        job_id,
        stats.processed,
        &stats,
        "completed",
        None,
    );

    let _ = db.execute_batch("PRAGMA analysis_limit = 1000; PRAGMA optimize;");
    log::info!(
        "{} index complete: {} changed, {} unchanged/skipped, {} deleted, {} errors",
        config.mode.as_str(),
        stats.indexed,
        stats.skipped,
        stats.deleted,
        stats.errors
    );
    Ok(())
}

fn should_process(
    mode: IndexMode,
    existing: Option<&ExistingFile>,
    file_size: i64,
    modified_at: &str,
) -> bool {
    mode == IndexMode::Full
        || existing.map_or(true, |item| {
            item.file_size != file_size
                || item.modified_at != modified_at
                || item.content_hash.is_empty()
                || item.content_hash == "error"
        })
}

fn existing_file(
    db: &Connection,
    folder_id: i64,
    relative_path: &str,
) -> Result<Option<ExistingFile>, String> {
    db.query_row(
        "SELECT file_size_bytes, file_modified_at, content_hash, index_status
         FROM files WHERE folder_id = ?1 AND relative_path = ?2",
        params![folder_id, relative_path],
        |row| {
            Ok(ExistingFile {
                file_size: row.get(0)?,
                modified_at: row.get(1)?,
                content_hash: row.get(2)?,
                index_status: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
fn upsert_file(
    db: &Connection,
    config: &PipelineConfig,
    file_path: &Path,
    relative: &str,
    file_name: &str,
    file_size: i64,
    modified_at: &str,
    content_hash: &str,
    content_changed: bool,
) -> Result<i64, String> {
    let preview = format!("PDF document: {file_name}");
    let file_id = db
        .query_row(
            "INSERT INTO files (
                folder_id, relative_path, file_name, file_extension, file_size_bytes,
                content_hash, file_modified_at, index_status, indexed_at, text_preview
             ) VALUES (?1, ?2, ?3, 'pdf', ?4, ?5, ?6, 'indexed', datetime('now'), ?7)
             ON CONFLICT(folder_id, relative_path) DO UPDATE SET
                file_name = excluded.file_name,
                file_size_bytes = excluded.file_size_bytes,
                content_hash = excluded.content_hash,
                file_modified_at = excluded.file_modified_at,
                index_status = 'indexed',
                index_error = NULL,
                indexed_at = datetime('now'),
                text_preview = CASE WHEN ?8 THEN excluded.text_preview ELSE files.text_preview END,
                text_length = CASE WHEN ?8 THEN NULL ELSE files.text_length END,
                page_count = CASE WHEN ?8 THEN NULL ELSE files.page_count END,
                ocr_applied = CASE WHEN ?8 THEN 0 ELSE files.ocr_applied END,
                pdf_title = CASE WHEN ?8 THEN NULL ELSE files.pdf_title END,
                pdf_author = CASE WHEN ?8 THEN NULL ELSE files.pdf_author END,
                pdf_subject = CASE WHEN ?8 THEN NULL ELSE files.pdf_subject END,
                pdf_keywords = CASE WHEN ?8 THEN NULL ELSE files.pdf_keywords END
             RETURNING id",
            params![
                config.folder_id,
                relative,
                file_name,
                file_size,
                content_hash,
                modified_at,
                preview,
                content_changed,
            ],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    let absolute = normalized_absolute_path(file_path);
    db.execute(
        "INSERT INTO indexed_files (path, file_size, mtime, md5, status, index_time)
         VALUES (?1, ?2, ?3, ?4, 'indexed', datetime('now'))
         ON CONFLICT(path) DO UPDATE SET
            file_size = excluded.file_size,
            mtime = excluded.mtime,
            md5 = excluded.md5,
            status = 'indexed',
            index_time = datetime('now'),
            ocr_time = CASE WHEN ?5 THEN NULL ELSE indexed_files.ocr_time END",
        params![
            absolute,
            file_size,
            modified_at,
            content_hash,
            content_changed
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(file_id)
}

#[allow(clippy::too_many_arguments)]
fn mark_skipped_file(
    db: &Connection,
    config: &PipelineConfig,
    file_path: &Path,
    relative: &str,
    file_name: &str,
    file_size: i64,
    modified_at: &str,
    existing: Option<&ExistingFile>,
) -> Result<i64, String> {
    let message = format!(
        "File exceeds the configured {} byte indexing limit",
        config.max_file_size_bytes
    );
    let preview = format!("PDF document: {file_name}");
    let content_changed = existing.map_or(true, |item| {
        item.file_size != file_size || item.modified_at != modified_at
    });
    let file_id = db
        .query_row(
            "INSERT INTO files (
                folder_id, relative_path, file_name, file_extension, file_size_bytes,
                content_hash, file_modified_at, index_status, index_error, text_preview
             ) VALUES (?1, ?2, ?3, 'pdf', ?4, '', ?5, 'skipped', ?6, ?7)
             ON CONFLICT(folder_id, relative_path) DO UPDATE SET
                file_name = excluded.file_name,
                file_size_bytes = excluded.file_size_bytes,
                file_modified_at = excluded.file_modified_at,
                index_status = 'skipped',
                index_error = excluded.index_error,
                indexed_at = NULL,
                content_hash = CASE WHEN ?8 THEN '' ELSE files.content_hash END,
                text_preview = CASE WHEN ?8 THEN excluded.text_preview ELSE files.text_preview END,
                text_length = CASE WHEN ?8 THEN NULL ELSE files.text_length END,
                ocr_applied = CASE WHEN ?8 THEN 0 ELSE files.ocr_applied END
             RETURNING id",
            params![
                config.folder_id,
                relative,
                file_name,
                file_size,
                modified_at,
                message,
                preview,
                content_changed,
            ],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    db.execute(
        "INSERT INTO indexed_files (path, file_size, mtime, md5, status, index_time)
         VALUES (?1, ?2, ?3, '', 'skipped', datetime('now'))
         ON CONFLICT(path) DO UPDATE SET file_size = excluded.file_size,
            mtime = excluded.mtime, md5 = '', status = 'skipped', index_time = datetime('now')",
        params![normalized_absolute_path(file_path), file_size, modified_at],
    )
    .map_err(|error| error.to_string())?;
    Ok(file_id)
}

fn delete_missing_files(
    db: &Connection,
    config: &PipelineConfig,
    engine: Option<&SearchEngine>,
    pending_search_deletes: &mut Vec<i64>,
) -> Result<u64, String> {
    let mut deleted = 0u64;
    loop {
        let stale = {
            let mut statement = db
                .prepare(
                    "SELECT files.id, files.relative_path
                     FROM files
                     WHERE files.folder_id = ?1
                       AND NOT EXISTS (
                           SELECT 1 FROM scan_seen WHERE scan_seen.relative_path = files.relative_path
                       )
                     LIMIT ?2",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![config.folder_id, DELETE_BATCH_SIZE as i64], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        };
        if stale.is_empty() {
            break;
        }

        let ids: Vec<i64> = stale.iter().map(|(id, _)| *id).collect();
        if config.mode == IndexMode::Incremental {
            pending_search_deletes.extend(ids.iter().copied());
            if pending_search_deletes.len() >= SEARCH_BATCH_SIZE {
                let mut no_upserts = Vec::new();
                flush_search_changes(engine, &mut no_upserts, pending_search_deletes);
            }
        }
        for (_, relative) in &stale {
            let absolute = normalized_absolute_path(&config.root_path.join(relative));
            db.execute("DELETE FROM indexed_files WHERE path = ?1", [absolute])
                .map_err(|error| error.to_string())?;
        }
        let placeholders = std::iter::repeat("?")
            .take(ids.len())
            .collect::<Vec<_>>()
            .join(",");
        db.execute(
            &format!("DELETE FROM files WHERE id IN ({placeholders})"),
            params_from_iter(ids.iter()),
        )
        .map_err(|error| error.to_string())?;
        deleted += ids.len() as u64;
    }
    Ok(deleted)
}

fn flush_search_changes(
    engine: Option<&SearchEngine>,
    upserts: &mut Vec<SearchDocument>,
    deletes: &mut Vec<i64>,
) {
    if let Some(engine) = engine {
        if let Err(error) = engine.apply_changes(upserts, deletes) {
            log::error!("Failed to apply incremental search changes: {error}");
        }
    }
    upserts.clear();
    deletes.clear();
}

#[allow(clippy::too_many_arguments)]
fn emit_if_due(
    config: &PipelineConfig,
    app_handle: &AppHandle,
    db: &Connection,
    job_id: i64,
    estimated_total: u64,
    stats: &ScanStats,
    current_file: Option<String>,
    last_progress: &mut Instant,
) {
    if last_progress.elapsed() < PROGRESS_INTERVAL {
        return;
    }
    let total = estimated_total.max(stats.processed);
    update_job(db, job_id, total, stats);
    emit_progress(
        config,
        app_handle,
        job_id,
        total,
        stats,
        "running",
        current_file,
    );
    *last_progress = Instant::now();
}

fn update_job(db: &Connection, job_id: i64, total: u64, stats: &ScanStats) {
    let _ = db.execute(
        "UPDATE index_jobs
         SET files_total = ?1, files_processed = ?2, files_indexed = ?3,
             files_skipped = ?4, files_errors = ?5, bytes_processed = ?6
         WHERE id = ?7",
        params![
            total as i64,
            stats.processed as i64,
            stats.indexed as i64,
            stats.skipped as i64,
            stats.errors as i64,
            stats.bytes_processed as i64,
            job_id,
        ],
    );
}

fn emit_progress(
    config: &PipelineConfig,
    app_handle: &AppHandle,
    job_id: i64,
    total: u64,
    stats: &ScanStats,
    status: &str,
    current_file: Option<String>,
) {
    let _ = app_handle.emit(
        "indexing:progress",
        IndexProgress {
            job_id,
            folder_id: Some(config.folder_id),
            index_mode: config.mode.as_str().to_string(),
            status: status.to_string(),
            ocr_after_index: config.ocr_after_index,
            files_total: total as i64,
            files_processed: stats.processed as i64,
            files_indexed: stats.indexed as i64,
            files_skipped: stats.skipped as i64,
            files_errors: stats.errors as i64,
            bytes_processed: stats.bytes_processed as i64,
            current_file,
        },
    );
}

fn relative_path(root: &Path, file_path: &Path) -> String {
    file_path
        .strip_prefix(root)
        .unwrap_or(file_path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn normalized_absolute_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn format_system_time(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339_opts(SecondsFormat::Nanos, true)
}

#[cfg(test)]
mod tests {
    use super::{
        delete_missing_files, format_system_time, should_process, upsert_file, ExistingFile,
        IndexMode, PipelineConfig,
    };
    use crate::db::schema;
    use rusqlite::Connection;
    use std::fs;
    use std::time::SystemTime;

    fn existing() -> ExistingFile {
        ExistingFile {
            file_size: 100,
            modified_at: "2026-01-01T00:00:00Z".to_string(),
            content_hash: "hash".to_string(),
            index_status: "indexed".to_string(),
        }
    }

    #[test]
    fn incremental_mode_skips_unchanged_metadata() {
        let item = existing();
        assert!(!should_process(
            IndexMode::Incremental,
            Some(&item),
            100,
            "2026-01-01T00:00:00Z"
        ));
        assert!(should_process(
            IndexMode::Incremental,
            Some(&item),
            101,
            "2026-01-01T00:00:00Z"
        ));
        assert!(should_process(IndexMode::Incremental, None, 100, "time"));
    }

    #[test]
    fn full_mode_always_processes_existing_files() {
        let item = existing();
        assert!(should_process(
            IndexMode::Full,
            Some(&item),
            item.file_size,
            &item.modified_at
        ));
    }

    #[test]
    fn parses_modes_and_defaults_to_incremental() {
        assert_eq!(IndexMode::parse(None).unwrap(), IndexMode::Incremental);
        assert_eq!(IndexMode::parse(Some("full")).unwrap(), IndexMode::Full);
        assert!(IndexMode::parse(Some("unknown")).is_err());
    }

    #[test]
    fn formats_file_times_as_rfc3339() {
        assert_eq!(
            format_system_time(SystemTime::UNIX_EPOCH),
            "1970-01-01T00:00:00.000000000Z"
        );
    }

    #[test]
    fn changed_content_resets_ocr_and_missing_files_are_removed() {
        let root = std::env::temp_dir().join(format!(
            "xdocuments-incremental-pipeline-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let conn = Connection::open_in_memory().unwrap();
        schema::run_migrations(&conn).unwrap();
        conn.execute(
            "INSERT INTO watched_folders (id, path) VALUES (1, ?1)",
            [root.to_string_lossy().as_ref()],
        )
        .unwrap();
        let config = PipelineConfig {
            root_path: root.clone(),
            folder_id: 1,
            mode: IndexMode::Incremental,
            ocr_after_index: true,
            max_file_size_bytes: 1_000_000,
        };

        let first_id = upsert_file(
            &conn,
            &config,
            &root.join("first.pdf"),
            "first.pdf",
            "first.pdf",
            10,
            "2026-01-01T00:00:00Z",
            "hash-a",
            true,
        )
        .unwrap();
        conn.execute(
            "UPDATE files SET ocr_applied = 1, text_preview = 'recognized text', text_length = 15 WHERE id = ?1",
            [first_id],
        )
        .unwrap();

        upsert_file(
            &conn,
            &config,
            &root.join("first.pdf"),
            "first.pdf",
            "first.pdf",
            10,
            "2026-01-02T00:00:00Z",
            "hash-a",
            false,
        )
        .unwrap();
        let preserved: (i64, String) = conn
            .query_row(
                "SELECT ocr_applied, text_preview FROM files WHERE id = ?1",
                [first_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(preserved, (1, "recognized text".to_string()));

        upsert_file(
            &conn,
            &config,
            &root.join("first.pdf"),
            "first.pdf",
            "first.pdf",
            11,
            "2026-01-03T00:00:00Z",
            "hash-b",
            true,
        )
        .unwrap();
        let reset: (i64, Option<i64>, String) = conn
            .query_row(
                "SELECT ocr_applied, text_length, text_preview FROM files WHERE id = ?1",
                [first_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(reset, (0, None, "PDF document: first.pdf".to_string()));

        let stale_id = upsert_file(
            &conn,
            &config,
            &root.join("stale.pdf"),
            "stale.pdf",
            "stale.pdf",
            9,
            "2026-01-01T00:00:00Z",
            "hash-stale",
            true,
        )
        .unwrap();
        conn.execute_batch(
            "CREATE TEMP TABLE scan_seen (relative_path TEXT PRIMARY KEY) WITHOUT ROWID;
             INSERT INTO scan_seen (relative_path) VALUES ('first.pdf');",
        )
        .unwrap();
        let mut search_deletes = Vec::new();
        assert_eq!(
            delete_missing_files(&conn, &config, None, &mut search_deletes).unwrap(),
            1
        );
        assert_eq!(search_deletes, vec![stale_id]);
        let stale_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM files WHERE id = ?1",
                [stale_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale_count, 0);

        drop(conn);
        let _ = fs::remove_dir_all(root);
    }
}
