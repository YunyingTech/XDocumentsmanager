use tauri::State;
use crate::db::Database;
use crate::models::{FolderInfo, FolderConfig};
use crate::search::SearchEngine;

#[tauri::command]
pub fn add_folder(
    path: String,
    config: Option<FolderConfig>,
    db: State<'_, Database>,
) -> Result<FolderInfo, String> {
    let conn = db.get_connection();
    let config = config.unwrap_or(FolderConfig {
        display_name: None,
        folder_type: None,
        smb_username: None,
        smb_domain: None,
        smb_password: None,
        watch_mode: None,
        poll_interval_secs: None,
    });

    let folder_type = config.folder_type.unwrap_or_else(|| {
        if path.starts_with("\\\\") { "smb".to_string() } else { "local".to_string() }
    });

    let display_name = config.display_name.unwrap_or_else(|| {
        path.split('\\').last().unwrap_or(&path).to_string()
    });

    conn.execute(
        "INSERT INTO watched_folders (path, display_name, folder_type, smb_username, smb_domain, watch_mode, poll_interval_secs)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            path,
            display_name,
            folder_type,
            config.smb_username,
            config.smb_domain,
            config.watch_mode.unwrap_or_else(|| "manual".to_string()),
            config.poll_interval_secs.unwrap_or(300),
        ],
    ).map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();

    let mut stmt = conn.prepare(
        "SELECT id, path, display_name, folder_type, smb_username, smb_domain,
                is_active, watch_mode, poll_interval_secs, last_scan_at, last_scan_status,
                total_files, total_size_bytes, created_at, updated_at
         FROM watched_folders WHERE id = ?1"
    ).map_err(|e| e.to_string())?;

    let folder = stmt.query_row([id], |row| crate::db::row_to_folder_info(row))
        .map_err(|e| e.to_string())?;

    Ok(folder)
}

#[tauri::command]
pub fn remove_folder(folder_id: i64, db: State<'_, Database>, engine: State<'_, SearchEngine>) -> Result<(), String> {
    let conn = db.get_connection();
    conn.execute("DELETE FROM watched_folders WHERE id = ?1", [folder_id])
        .map_err(|e| e.to_string())?;
    engine.delete_folder(folder_id)?;
    Ok(())
}

#[tauri::command]
pub fn list_folders(db: State<'_, Database>) -> Result<Vec<FolderInfo>, String> {
    let conn = db.get_connection();
    let mut stmt = conn.prepare(
        "SELECT id, path, display_name, folder_type, smb_username, smb_domain,
                is_active, watch_mode, poll_interval_secs, last_scan_at, last_scan_status,
                total_files, total_size_bytes, created_at, updated_at
         FROM watched_folders ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;

    let folders = stmt.query_map([], |row| crate::db::row_to_folder_info(row))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(folders)
}

#[tauri::command]
pub fn update_folder(
    folder_id: i64,
    config: FolderConfig,
    db: State<'_, Database>,
) -> Result<FolderInfo, String> {
    let conn = db.get_connection();

    if let Some(ref name) = config.display_name {
        conn.execute("UPDATE watched_folders SET display_name = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![name, folder_id]).map_err(|e| e.to_string())?;
    }
    if let Some(ref mode) = config.watch_mode {
        conn.execute("UPDATE watched_folders SET watch_mode = ?1, updated_at = datetime('now') WHERE id = ?2",
            rusqlite::params![mode, folder_id]).map_err(|e| e.to_string())?;
    }

    let mut stmt = conn.prepare(
        "SELECT id, path, display_name, folder_type, smb_username, smb_domain,
                is_active, watch_mode, poll_interval_secs, last_scan_at, last_scan_status,
                total_files, total_size_bytes, created_at, updated_at
         FROM watched_folders WHERE id = ?1"
    ).map_err(|e| e.to_string())?;

    let folder = stmt.query_row([folder_id], |row| crate::db::row_to_folder_info(row))
        .map_err(|e| e.to_string())?;

    Ok(folder)
}
