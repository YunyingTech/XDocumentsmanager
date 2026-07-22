use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::Database;
use crate::models::{FileInfo, SearchFilters, SearchResult};
use crate::search::engine::normalize_cjk_ocr_spacing;
use crate::search::query::expand_query;
use crate::search::SearchEngine;

#[derive(Clone, Serialize)]
struct SearchProgress {
    request_id: u64,
    stage: &'static str,
    progress: u8,
}

fn emit_progress(app: &AppHandle, request_id: u64, stage: &'static str, progress: u8) {
    let _ = app.emit(
        "search:progress",
        SearchProgress {
            request_id,
            stage,
            progress,
        },
    );
}

#[tauri::command]
pub async fn search(
    query: String,
    filters: Option<SearchFilters>,
    limit: Option<i64>,
    request_id: Option<u64>,
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<Vec<SearchResult>, String> {
    let request_id = request_id.unwrap_or(0);
    let limit = limit.unwrap_or(100).clamp(1, 500) as usize;
    emit_progress(&app, request_id, "analyzing", 15);
    log::info!("Search {}: analyzing query", request_id);
    let expanded = expand_query(&db, &query).await.unwrap_or_else(|error| {
        log::warn!(
            "Smart query expansion failed; using the original query: {}",
            error
        );
        query.clone()
    });
    emit_progress(&app, request_id, "searching", 50);
    log::info!("Search {}: querying full-text index", request_id);
    let search_app = app.clone();
    let search_filters = filters.clone();
    let hit_limit = limit.saturating_mul(5).min(1_000);
    let hits = match tokio::task::spawn_blocking(move || {
        let engine = search_app.state::<SearchEngine>();
        engine.search(&expanded, search_filters.as_ref(), hit_limit)
    })
    .await
    {
        Ok(Ok(hits)) => hits,
        Ok(Err(error)) => {
            emit_progress(&app, request_id, "failed", 100);
            log::error!("Search {} failed: {}", request_id, error);
            return Err(error);
        }
        Err(error) => {
            let message = format!("Search worker failed: {}", error);
            emit_progress(&app, request_id, "failed", 100);
            log::error!("Search {} failed: {}", request_id, message);
            return Err(message);
        }
    };
    emit_progress(&app, request_id, "resolving", 78);
    log::info!("Search {}: resolving {} index hits", request_id, hits.len());
    let conn = db.get_connection();
    let mut results = Vec::with_capacity(limit);

    for hit in hits {
        let (file, folder_path) = match load_file(&conn, hit.file_id) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !matches_filters(&file, filters.as_ref()) {
            continue;
        }
        let absolute_path = Path::new(&folder_path)
            .join(&file.relative_path)
            .to_string_lossy()
            .to_string();
        let searchable_preview =
            normalize_cjk_ocr_spacing(file.text_preview.as_deref().unwrap_or_default());
        results.push(SearchResult {
            snippet: make_snippet(&searchable_preview, &query),
            file,
            score: hit.score as f64,
            folder_path,
            absolute_path,
        });
        if results.len() == limit {
            break;
        }
    }

    let _ = conn.execute(
        "INSERT INTO search_history (query_text, result_count) VALUES (?1, ?2)",
        rusqlite::params![query, results.len() as i64],
    );
    emit_progress(&app, request_id, "completed", 100);
    log::info!(
        "Search {} completed with {} results",
        request_id,
        results.len()
    );
    Ok(results)
}

fn make_snippet(content: &str, query: &str) -> String {
    let lower = content.to_lowercase();
    let position = query
        .split_whitespace()
        .map(|term| term.trim_matches(['\"', '(', ')']))
        .filter(|term| !term.is_empty())
        .filter_map(|term| lower.find(&term.to_lowercase()))
        .min()
        .unwrap_or(0);
    let mut safe_position = position.min(content.len());
    while safe_position > 0 && !content.is_char_boundary(safe_position) {
        safe_position -= 1;
    }
    let start = content[..safe_position]
        .char_indices()
        .rev()
        .nth(80)
        .map(|(index, _)| index)
        .unwrap_or(0);
    content[start..].chars().take(320).collect()
}

fn load_file(conn: &rusqlite::Connection, file_id: i64) -> Result<(FileInfo, String), String> {
    conn.query_row(
        "SELECT f.id, f.folder_id, f.relative_path, f.file_name, f.file_extension, f.file_size_bytes, f.content_hash, f.page_count, f.text_length, f.file_created_at, f.file_modified_at, f.indexed_at, f.index_status, f.index_error, f.text_preview, f.ocr_applied, f.pdf_title, f.pdf_author, f.pdf_subject, f.pdf_keywords, wf.path FROM files f JOIN watched_folders wf ON wf.id = f.folder_id WHERE f.id = ?1",
        [file_id],
        |row| Ok((crate::db::row_to_file_info(row)?, row.get(20)?)),
    ).map_err(|e| e.to_string())
}

fn matches_filters(file: &FileInfo, filters: Option<&SearchFilters>) -> bool {
    let Some(filters) = filters else { return true };
    if filters
        .folder_id
        .is_some_and(|value| file.folder_id != value)
    {
        return false;
    }
    if filters
        .size_min
        .is_some_and(|value| file.file_size_bytes < value)
    {
        return false;
    }
    if filters
        .size_max
        .is_some_and(|value| file.file_size_bytes > value)
    {
        return false;
    }
    if filters
        .file_extension
        .as_ref()
        .is_some_and(|value| !file.file_extension.eq_ignore_ascii_case(value))
    {
        return false;
    }
    if filters
        .date_from
        .as_ref()
        .is_some_and(|value| file.file_modified_at < *value)
    {
        return false;
    }
    if filters
        .date_to
        .as_ref()
        .is_some_and(|value| file.file_modified_at > *value)
    {
        return false;
    }
    true
}
