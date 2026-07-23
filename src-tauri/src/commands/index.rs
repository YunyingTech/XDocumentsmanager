use tauri::{State, AppHandle};
use std::path::PathBuf;
use crate::db::Database;
use crate::models::IndexJob;
use crate::indexer::pipeline::{self, PipelineConfig};

#[tauri::command]
pub async fn start_indexing(
    app_handle: AppHandle,
    folder_id: Option<i64>,
    ocr_after_index: Option<bool>,
    db: State<'_, Database>,
) -> Result<i64, String> {
    let folder_id = folder_id.ok_or("folder_id is required")?;
    let ocr_after_index = ocr_after_index.unwrap_or(false);

    // Get folder path from DB
    let folder_path: String = {
        let conn = db.get_connection();
        conn.query_row(
            "SELECT path FROM watched_folders WHERE id = ?1",
            [folder_id],
            |row| row.get(0),
        ).map_err(|e| format!("Folder not found: {}", e))?
    };

    // Create an index job
    let job_id: i64 = {
        let conn = db.get_connection();
        conn.execute(
            "INSERT INTO index_jobs (folder_id, job_type, status, started_at)
             VALUES (?1, 'manual_reindex', 'running', datetime('now'))",
            rusqlite::params![folder_id],
        ).map_err(|e| e.to_string())?;

        // Update folder status
        conn.execute(
            "UPDATE watched_folders SET last_scan_status = 'running', updated_at = datetime('now') WHERE id = ?1",
            [folder_id],
        ).map_err(|e| e.to_string())?;

        conn.last_insert_rowid()
    };

    // Spawn the actual indexing work in the background — return job_id immediately
    let root_path = PathBuf::from(&folder_path);
    let db_path = db.path().clone();

    let config = PipelineConfig {
        root_path,
        folder_id,
        ocr_after_index,
        num_workers: 4,
        max_file_size_bytes: 500 * 1024 * 1024, // 500MB
    };

    // Clone db_path for use after the spawn_blocking closure
    let db_path2 = db_path.clone();

    // Use tokio::spawn so we can return immediately.
    // The indexing work uses its own DB connection and emits progress via app_handle.
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| format!("Failed to open DB for indexing: {}", e))?;
            conn.execute_batch("PRAGMA journal_mode = WAL;").map_err(|e| e.to_string())?;
            pipeline::run_full_index(config, &conn, &app_handle, job_id)
        }).await;

        // Update job status in DB based on result
        let conn = match rusqlite::Connection::open(&db_path2) {
            Ok(c) => {
                let _ = c.execute_batch("PRAGMA journal_mode = WAL;");
                c
            }
            Err(e) => {
                log::error!("Failed to open DB for final status update: {}", e);
                return;
            }
        };

        match result {
            Ok(Ok(_)) => {
                let _ = conn.execute(
                    "UPDATE index_jobs SET status = 'completed', completed_at = datetime('now') WHERE id = ?1",
                    [job_id],
                );
                let _ = conn.execute(
                    "UPDATE watched_folders SET last_scan_status = 'completed', last_scan_at = datetime('now'), updated_at = datetime('now') WHERE id = ?1",
                    [folder_id],
                );
                // (final completed event already emitted by pipeline with real counts)
            }
            Ok(Err(ref e)) => {
                let _ = conn.execute(
                    "UPDATE index_jobs SET status = 'error', error_message = ?1, completed_at = datetime('now') WHERE id = ?2",
                    rusqlite::params![e, job_id],
                );
                let _ = conn.execute(
                    "UPDATE watched_folders SET last_scan_status = 'error', updated_at = datetime('now') WHERE id = ?1",
                    [folder_id],
                );
            }
            Err(e) => {
                let _ = conn.execute(
                    "UPDATE index_jobs SET status = 'error', error_message = ?1, completed_at = datetime('now') WHERE id = ?2",
                    rusqlite::params![e.to_string(), job_id],
                );
                let _ = conn.execute(
                    "UPDATE watched_folders SET last_scan_status = 'error', updated_at = datetime('now') WHERE id = ?1",
                    [folder_id],
                );
            }
        }
    });

    Ok(job_id)
}

#[tauri::command]
pub fn pause_indexing(job_id: i64, db: State<'_, Database>) -> Result<(), String> {
    let conn = db.get_connection();
    conn.execute(
        "UPDATE index_jobs SET status = 'paused' WHERE id = ?1",
        [job_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_index_status(db: State<'_, Database>) -> Result<Option<IndexJob>, String> {
    let conn = db.get_connection();
    let mut stmt = conn.prepare(
        "SELECT id, folder_id, job_type, status, files_total, files_processed,
                files_indexed, files_skipped, files_errors, bytes_processed,
                started_at, completed_at, error_message
         FROM index_jobs ORDER BY created_at DESC LIMIT 1"
    ).map_err(|e| e.to_string())?;

    let result = stmt.query_row([], |row| {
        Ok(IndexJob {
            id: row.get(0)?,
            folder_id: row.get(1)?,
            job_type: row.get(2)?,
            status: row.get(3)?,
            files_total: row.get(4)?,
            files_processed: row.get(5)?,
            files_indexed: row.get(6)?,
            files_skipped: row.get(7)?,
            files_errors: row.get(8)?,
            bytes_processed: row.get(9)?,
            started_at: row.get(10)?,
            completed_at: row.get(11)?,
            error_message: row.get(12)?,
        })
    });

    match result {
        Ok(job) => Ok(Some(job)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn reindex_file(file_id: i64, db: State<'_, Database>) -> Result<(), String> {
    let conn = db.get_connection();
    conn.execute(
        "UPDATE files SET index_status = 'pending', indexed_at = NULL, index_error = NULL WHERE id = ?1",
        [file_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}
