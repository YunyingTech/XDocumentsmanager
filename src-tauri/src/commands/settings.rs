use tauri::State;
use crate::db::Database;

#[tauri::command]
pub fn get_setting(key: String, db: State<'_, Database>) -> Result<Option<String>, String> {
    let conn = db.get_connection();
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|e| e.to_string())?;

    let result = stmt.query_row([&key], |row| row.get::<_, String>(0));

    match result {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn set_setting(key: String, value: String, db: State<'_, Database>) -> Result<(), String> {
    let conn = db.get_connection();
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        rusqlite::params![key, value],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_db_path(db: State<'_, Database>) -> Result<String, String> {
    Ok(db.path().to_string_lossy().to_string())
}

#[tauri::command]
pub fn vacuum_database(db: State<'_, Database>) -> Result<String, String> {
    let conn = db.get_connection();
    let before: i64 = conn.query_row("PRAGMA page_count;", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let page_size: i64 = conn.query_row("PRAGMA page_size;", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let before_size = before * page_size;

    conn.execute_batch("VACUUM;").map_err(|e| e.to_string())?;

    let after: i64 = conn.query_row("PRAGMA page_count;", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let after_size = after * page_size;

    let saved = before_size - after_size;
    Ok(format!(
        "VACUUM complete: {} → {} (saved {})",
        format_bytes(before_size),
        format_bytes(after_size),
        format_bytes(saved),
    ))
}

fn format_bytes(bytes: i64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}
