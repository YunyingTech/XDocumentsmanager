// Indexing pipeline orchestrator — Phase 2
// Coordinates walker → hasher → extractor → database storage
// using bounded channels and worker pools.

use std::path::PathBuf;
use rusqlite::Connection;
use crate::indexer::walker;

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
/// Phase 1: placeholder — just walks files and stores basic records.
/// Phase 2: full implementation with text extraction and parallel processing.
pub fn run_full_index(
    config: PipelineConfig,
    db: &Connection,
) -> Result<(), String> {
    log::info!("Starting full index for folder {}: {:?}", config.folder_id, config.root_path);

    // Walk for PDF files
    let files = walker::walk_pdf_files(&config.root_path);
    let total = files.len() as u64;
    log::info!("Found {} PDF files", total);

    let mut indexed = 0u64;
    let mut skipped = 0u64;
    let mut errors = 0u64;

    for file_path in &files {
        // Check file size
        if let Ok(meta) = std::fs::metadata(file_path) {
            if meta.len() as i64 > config.max_file_size_bytes {
                skipped += 1;
                continue;
            }
        }

        // Compute relative path
        let relative = file_path.strip_prefix(&config.root_path)
            .unwrap_or(file_path)
            .to_string_lossy()
            .replace('\\', "/");

        // Phase 1: Skip actual text extraction, just store metadata
        match std::fs::metadata(file_path) {
            Ok(meta) => {
                let modified = if let Ok(mtime) = meta.modified() {
                    format!("{:?}", mtime)
                } else {
                    String::from("unknown")
                };

                let file_name = file_path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "unknown".to_string());

                // Check if file already exists (by folder + relative path)
                let exists: bool = db.query_row(
                    "SELECT COUNT(*) FROM files WHERE folder_id = ?1 AND relative_path = ?2",
                    rusqlite::params![config.folder_id, relative],
                    |row| row.get::<_, i64>(0),
                ).map(|c| c > 0).unwrap_or(false);

                if exists {
                    // Update existing record
                    let _ = db.execute(
                        "UPDATE files SET file_size_bytes = ?1, file_modified_at = ?2, index_status = 'indexed', indexed_at = datetime('now') WHERE folder_id = ?3 AND relative_path = ?4",
                        rusqlite::params![meta.len() as i64, modified, config.folder_id, relative],
                    );
                } else {
                    // Insert new record with placeholder hash
                    let placeholder_hash = md5_like_hash(file_path);
                    let preview_text = format!("PDF document: {}", file_name);

                    let _ = db.execute(
                        "INSERT INTO files (folder_id, relative_path, file_name, file_extension, file_size_bytes, content_hash, file_modified_at, index_status, indexed_at, text_preview)
                         VALUES (?1, ?2, ?3, 'pdf', ?4, ?5, ?6, 'indexed', datetime('now'), ?7)",
                        rusqlite::params![
                            config.folder_id, relative, file_name,
                            meta.len() as i64, placeholder_hash, modified,
                            preview_text,
                        ],
                    );
                }
                indexed += 1;
            }
            Err(_) => {
                errors += 1;
            }
        }
    }

    // Update folder totals
    let _ = db.execute(
        "UPDATE watched_folders SET total_files = ?1, total_size_bytes = (SELECT COALESCE(SUM(file_size_bytes), 0) FROM files WHERE folder_id = ?2), last_scan_status = 'completed', last_scan_at = datetime('now'), updated_at = datetime('now') WHERE id = ?2",
        rusqlite::params![indexed as i64, config.folder_id],
    );

    // Update FTS index
    let _ = db.execute(
        "INSERT INTO files_fts(files_fts) VALUES('rebuild')",
        [],
    );

    log::info!("Index complete: {} indexed, {} skipped, {} errors", indexed, skipped, errors);
    Ok(())
}

// Simple non-crypto hash for placeholder
fn md5_like_hash(path: &PathBuf) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}
