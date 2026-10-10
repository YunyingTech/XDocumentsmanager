use tauri::State;
use crate::db::Database;
use crate::models::{OpenAiConfig, OpenAiConnectionInfo, SearchBackendStatus};
use crate::search::SearchEngine;

#[tauri::command]
pub async fn get_setting(
    key: String,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    crate::background::run(move || {
        let db = crate::background::state::<Database>(&app)?;
        if key == "openai_api_key_protected" {
            return Ok(None);
        }
        let conn = db.get_connection();
        let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")
            .map_err(|e| e.to_string())?;

        let result = stmt.query_row([&key], |row| row.get::<_, String>(0));

        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
}

#[tauri::command]
pub async fn get_openai_config(
    app: tauri::AppHandle,
) -> Result<OpenAiConfig, String> {
    crate::background::run(move || {
        let db = crate::background::state::<Database>(&app)?;
        Ok(crate::search::query::load_config(&db))
    })
    .await
}

#[tauri::command]
pub async fn set_openai_config(
    endpoint: String,
    model: String,
    api_key: Option<String>,
    smart_search_enabled: bool,
    app: tauri::AppHandle,
) -> Result<OpenAiConfig, String> {
    crate::background::run(move || {
        let db = crate::background::state::<Database>(&app)?;
        crate::search::query::save_config(&db, endpoint, model, api_key, smart_search_enabled)
    })
    .await
}

#[tauri::command]
pub async fn test_openai_connection(db: State<'_, Database>) -> Result<OpenAiConnectionInfo, String> {
    crate::search::query::test_connection(&db).await
}

#[tauri::command]
pub async fn get_search_backend_status(
    app: tauri::AppHandle,
) -> Result<SearchBackendStatus, String> {
    crate::background::run(move || {
        let engine = crate::background::state::<SearchEngine>(&app)?;
        Ok(engine.backend_status())
    })
    .await
}

#[tauri::command]
pub async fn set_setting(
    key: String,
    value: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    crate::background::run(move || {
        let db = crate::background::state::<Database>(&app)?;
        let conn = db.get_connection();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
            rusqlite::params![key, value],
        ).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn get_db_path(db: State<'_, Database>) -> Result<String, String> {
    Ok(db.path().to_string_lossy().to_string())
}

#[tauri::command]
pub async fn vacuum_database(
    app: tauri::AppHandle,
) -> Result<String, String> {
    crate::background::run(move || {
        let db = crate::background::state::<Database>(&app)?;
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
    })
    .await
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
