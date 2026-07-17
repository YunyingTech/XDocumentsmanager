pub mod schema;

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Database {
    pub conn: Mutex<Connection>,
    pub db_path: PathBuf,
}

impl Database {
    pub fn new(app_data_dir: &PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(app_data_dir)?;
        let db_path = app_data_dir.join("xdocuments.db");
        let conn = Connection::open(&db_path)?;
        schema::run_migrations(&conn)?;
        Ok(Database {
            conn: Mutex::new(conn),
            db_path,
        })
    }

    pub fn get_connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }

    pub fn path(&self) -> &PathBuf {
        &self.db_path
    }
}

// Helper to map rows to FileInfo
pub fn row_to_file_info(row: &rusqlite::Row) -> rusqlite::Result<super::models::FileInfo> {
    use super::models::FileInfo;
    Ok(FileInfo {
        id: row.get(0)?,
        folder_id: row.get(1)?,
        relative_path: row.get(2)?,
        file_name: row.get(3)?,
        file_extension: row.get(4)?,
        file_size_bytes: row.get(5)?,
        content_hash: row.get(6)?,
        page_count: row.get(7)?,
        text_length: row.get(8)?,
        file_created_at: row.get(9)?,
        file_modified_at: row.get(10)?,
        indexed_at: row.get(11)?,
        index_status: row.get(12)?,
        index_error: row.get(13)?,
        text_preview: row.get(14)?,
        ocr_applied: row.get::<_, i32>(15)? != 0,
        pdf_title: row.get(16)?,
        pdf_author: row.get(17)?,
        pdf_subject: row.get(18)?,
        pdf_keywords: row.get(19)?,
    })
}

// Helper to map rows to FolderInfo
pub fn row_to_folder_info(row: &rusqlite::Row) -> rusqlite::Result<super::models::FolderInfo> {
    use super::models::FolderInfo;
    Ok(FolderInfo {
        id: row.get(0)?,
        path: row.get(1)?,
        display_name: row.get(2)?,
        folder_type: row.get(3)?,
        smb_username: row.get(4)?,
        smb_domain: row.get(5)?,
        is_active: row.get::<_, i32>(6)? != 0,
        watch_mode: row.get(7)?,
        poll_interval_secs: row.get(8)?,
        last_scan_at: row.get(9)?,
        last_scan_status: row.get(10)?,
        total_files: row.get(11)?,
        total_size_bytes: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}
