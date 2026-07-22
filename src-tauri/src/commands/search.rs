use std::path::Path;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::Database;
use crate::models::{FileInfo, SearchFilters, SearchQueryAnalysis, SearchResponse, SearchResult};
use crate::search::engine::normalize_cjk_ocr_spacing;
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
    terms: Option<Vec<String>>,
    filters: Option<SearchFilters>,
    limit: Option<i64>,
    request_id: Option<u64>,
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<SearchResponse, String> {
    let started = Instant::now();
    let request_id = request_id.unwrap_or(0);
    let limit = limit.unwrap_or(100).clamp(1, 500) as usize;
    let engine_query = selected_terms_query(terms.as_deref()).unwrap_or_else(|| query.clone());
    emit_progress(&app, request_id, "searching", 50);
    log::info!("Search {}: querying full-text index", request_id);
    let search_app = app.clone();
    let search_filters = filters.clone();
    let hit_limit = limit.saturating_mul(5).min(1_000);
    let hits = match tokio::task::spawn_blocking(move || {
        let engine = search_app.state::<SearchEngine>();
        engine.search(&engine_query, search_filters.as_ref(), hit_limit)
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
        "Search {} completed with {} results in {} ms",
        request_id,
        results.len(),
        started.elapsed().as_millis()
    );
    Ok(SearchResponse {
        results,
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

#[tauri::command]
pub async fn analyze_search_query(
    query: String,
    db: State<'_, Database>,
) -> Result<SearchQueryAnalysis, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("Search query cannot be empty".to_string());
    }
    crate::search::query::analyze_query(&db, query).await
}

fn selected_terms_query(terms: Option<&[String]>) -> Option<String> {
    let terms = terms?
        .iter()
        .map(|term| term.trim().replace(['\"', '\\'], ""))
        .filter(|term| !term.is_empty())
        .take(16)
        .map(|term| format!("\"{term}\""))
        .collect::<Vec<_>>();
    (!terms.is_empty()).then(|| terms.join(" | "))
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

#[cfg(test)]
mod tests {
    use super::selected_terms_query;

    #[test]
    fn builds_safe_or_query_from_selected_terms() {
        let terms = vec![
            "中科院".to_string(),
            " 中国科学院 ".to_string(),
            "\\\"网络安全\\\"".to_string(),
        ];
        assert_eq!(
            selected_terms_query(Some(&terms)),
            Some("\"中科院\" | \"中国科学院\" | \"网络安全\"".to_string())
        );
    }
}
