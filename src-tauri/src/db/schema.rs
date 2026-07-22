use rusqlite::Connection;

pub fn run_migrations(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    // Enable WAL mode for concurrent reads during indexing
    conn.execute_batch("PRAGMA journal_mode = WAL;")?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch("PRAGMA cache_size = -524288;")?; // 512MB page cache
    conn.execute_batch("PRAGMA page_size = 4096;")?;
    conn.execute_batch("PRAGMA synchronous = NORMAL;")?;

    // Create tables
    conn.execute_batch(CREATE_WATCHED_FOLDERS)?;
    conn.execute_batch(CREATE_FILES)?;
    conn.execute_batch(CREATE_INDEX_JOBS)?;
    conn.execute_batch(CREATE_SETTINGS)?;
    conn.execute_batch(CREATE_SEARCH_HISTORY)?;
    conn.execute_batch(CREATE_INDEXED_FILES)?;

    // Search is persisted by the embedded Tantivy engine.
    conn.execute_batch("DROP TABLE IF EXISTS files_fts;")?;

    // Insert default settings
    conn.execute_batch(INSERT_DEFAULT_SETTINGS)?;

    // Clean up unused tables from previous versions
    conn.execute_batch("DROP TABLE IF EXISTS file_tags;")?;
    conn.execute_batch("DROP TABLE IF EXISTS tags;")?;

    Ok(())
}

const CREATE_WATCHED_FOLDERS: &str = r#"
CREATE TABLE IF NOT EXISTS watched_folders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT NOT NULL UNIQUE,
    display_name    TEXT,
    folder_type     TEXT NOT NULL DEFAULT 'local',
    smb_username    TEXT,
    smb_domain      TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    watch_mode      TEXT NOT NULL DEFAULT 'manual',
    poll_interval_secs INTEGER DEFAULT 300,
    last_scan_at    TEXT,
    last_scan_status TEXT DEFAULT 'never',
    total_files     INTEGER DEFAULT 0,
    total_size_bytes INTEGER DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

const CREATE_FILES: &str = r#"
CREATE TABLE IF NOT EXISTS files (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id        INTEGER NOT NULL,
    relative_path    TEXT NOT NULL,
    file_name        TEXT NOT NULL,
    file_extension   TEXT DEFAULT 'pdf',
    file_size_bytes  INTEGER NOT NULL,
    content_hash     TEXT NOT NULL,
    page_count       INTEGER,
    text_length      INTEGER,
    file_created_at  TEXT,
    file_modified_at TEXT NOT NULL,
    indexed_at       TEXT,
    index_status     TEXT NOT NULL DEFAULT 'pending',
    index_error      TEXT,
    text_preview     TEXT,
    ocr_applied      INTEGER DEFAULT 0,
    pdf_title        TEXT,
    pdf_author       TEXT,
    pdf_subject      TEXT,
    pdf_keywords     TEXT,
    FOREIGN KEY (folder_id) REFERENCES watched_folders(id) ON DELETE CASCADE,
    UNIQUE(folder_id, relative_path)
);
"#;

const CREATE_INDEX_JOBS: &str = r#"
CREATE TABLE IF NOT EXISTS index_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id       INTEGER,
    job_type        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued',
    files_total     INTEGER DEFAULT 0,
    files_processed INTEGER DEFAULT 0,
    files_indexed   INTEGER DEFAULT 0,
    files_skipped   INTEGER DEFAULT 0,
    files_errors    INTEGER DEFAULT 0,
    bytes_processed INTEGER DEFAULT 0,
    started_at      TEXT,
    completed_at    TEXT,
    error_message   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (folder_id) REFERENCES watched_folders(id) ON DELETE SET NULL
);
"#;

const CREATE_SETTINGS: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

const CREATE_SEARCH_HISTORY: &str = r#"
CREATE TABLE IF NOT EXISTS search_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    query_text   TEXT NOT NULL,
    result_count INTEGER,
    searched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

const CREATE_INDEXED_FILES: &str = r#"
CREATE TABLE IF NOT EXISTS indexed_files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT NOT NULL UNIQUE,
    file_size  INTEGER NOT NULL,
    mtime      TEXT NOT NULL,
    md5        TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    ocr_time   TEXT,
    index_time TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"#;

const INSERT_DEFAULT_SETTINGS: &str = r#"
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('index_location', ''),
    ('max_file_size_mb', '500'),
    ('indexer_threads', '4'),
    ('poll_interval_secs', '300'),
    ('theme', 'system'),
    ('default_view', 'table'),
    ('ocr_enabled', 'false'),
    ('ocr_languages', 'eng'),
    ('ocr_api_url', 'http://127.0.0.1:8000'),
    ('ocr_output_dir', ''),
    ('openai_endpoint', 'https://api.openai.com/v1'),
    ('openai_model', 'gpt-4.1-mini'),
    ('openai_api_key_protected', ''),
    ('smart_search_enabled', 'true');
"#;

// Indexes (run after table creation)
pub fn create_indexes(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    conn.execute_batch(r#"
        CREATE INDEX IF NOT EXISTS idx_files_folder_id       ON files(folder_id);
        CREATE INDEX IF NOT EXISTS idx_files_index_status    ON files(index_status);
        CREATE INDEX IF NOT EXISTS idx_files_file_name       ON files(file_name);
        CREATE INDEX IF NOT EXISTS idx_files_modified        ON files(file_modified_at);
        CREATE INDEX IF NOT EXISTS idx_files_size            ON files(file_size_bytes);
        CREATE INDEX IF NOT EXISTS idx_files_content_hash    ON files(content_hash);
        CREATE INDEX IF NOT EXISTS idx_files_folder_status   ON files(folder_id, index_status);
        CREATE INDEX IF NOT EXISTS idx_indexed_files_status      ON indexed_files(status);
        CREATE INDEX IF NOT EXISTS idx_indexed_files_index_time  ON indexed_files(index_time);
        CREATE INDEX IF NOT EXISTS idx_indexed_files_md5         ON indexed_files(md5);
    "#)?;
    Ok(())
}
