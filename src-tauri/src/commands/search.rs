use std::collections::HashMap;
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
#[allow(clippy::too_many_arguments)]
pub async fn search(
    query: String,
    terms: Option<Vec<String>>,
    query_model: Option<String>,
    filters: Option<SearchFilters>,
    page: Option<i64>,
    page_size: Option<i64>,
    request_id: Option<u64>,
    app: AppHandle,
    db: State<'_, Database>,
) -> Result<SearchResponse, String> {
    let started = Instant::now();
    let request_id = request_id.unwrap_or(0);
    let page = page.unwrap_or(0).max(0);
    let page_size = page_size.unwrap_or(25).clamp(10, 100);
    let offset = page
        .checked_mul(page_size)
        .ok_or_else(|| "Search page offset is too large".to_string())? as usize;
    let selected_terms = normalize_selected_terms(terms.as_deref());
    let engine_query = selected_terms_query(&selected_terms).unwrap_or_else(|| query.clone());
    let match_model = if selected_terms.is_empty() {
        None
    } else {
        query_model
            .map(|model| model.trim().chars().take(128).collect::<String>())
            .filter(|model| !model.is_empty())
    };
    let highlight_terms = search_highlight_terms(&query, &selected_terms);
    emit_progress(&app, request_id, "searching", 50);
    log::info!("Search {}: querying full-text index", request_id);
    let search_app = app.clone();
    let search_filters = filters.clone();
    let search_page = match tokio::task::spawn_blocking(move || {
        let engine = search_app.state::<SearchEngine>();
        engine.search(
            &engine_query,
            search_filters.as_ref(),
            offset,
            page_size as usize,
        )
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
    log::info!(
        "Search {}: resolving {} of {} index hits",
        request_id,
        search_page.hits.len(),
        search_page.total
    );
    let conn = db.get_connection();
    let hydrated = load_files(
        &conn,
        &search_page
            .hits
            .iter()
            .map(|hit| hit.file_id)
            .collect::<Vec<_>>(),
    )?;
    let mut results = Vec::with_capacity(search_page.hits.len());

    for hit in search_page.hits {
        let Some((file, folder_path)) = hydrated.get(&hit.file_id).cloned() else {
            continue;
        };
        let absolute_path = Path::new(&folder_path)
            .join(&file.relative_path)
            .to_string_lossy()
            .to_string();
        let searchable_preview =
            normalize_cjk_ocr_spacing(file.text_preview.as_deref().unwrap_or_default());
        let matched_terms = matched_ai_terms(&file, &selected_terms);
        let snippet_query = highlight_terms.join(" ");
        results.push(SearchResult {
            snippet: make_snippet(&searchable_preview, &snippet_query),
            file,
            score: hit.score as f64,
            folder_path,
            absolute_path,
            matched_terms,
            highlight_terms: highlight_terms.clone(),
            match_model: match_model.clone(),
        });
    }

    let total = search_page.total.min(i64::MAX as u64) as i64;
    let total_pages = if total == 0 {
        0
    } else {
        (total + page_size - 1) / page_size
    };

    let _ = conn.execute(
        "INSERT INTO search_history (query_text, result_count) VALUES (?1, ?2)",
        rusqlite::params![query, total],
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
        total,
        page,
        page_size,
        total_pages,
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

fn normalize_selected_terms(terms: Option<&[String]>) -> Vec<String> {
    terms
        .unwrap_or_default()
        .iter()
        .map(|term| term.trim().replace(['\"', '\\'], ""))
        .filter(|term| !term.is_empty())
        .take(16)
        .collect()
}

fn selected_terms_query(terms: &[String]) -> Option<String> {
    (!terms.is_empty()).then(|| {
        terms
            .iter()
            .map(|term| format!("({})", escape_search_term(term)))
            .collect::<Vec<_>>()
            .join(" | ")
    })
}

fn escape_search_term(term: &str) -> String {
    let mut escaped = String::with_capacity(term.len());
    for character in term.chars() {
        if matches!(
            character,
            '+' | '|' | '-' | '(' | ')' | '"' | '*' | '~' | '\\' | ':'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn matched_ai_terms(file: &FileInfo, terms: &[String]) -> Vec<String> {
    if terms.is_empty() {
        return Vec::new();
    }
    let searchable = [
        Some(file.file_name.as_str()),
        file.text_preview.as_deref(),
        file.pdf_title.as_deref(),
        file.pdf_author.as_deref(),
        file.pdf_keywords.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n");
    matching_ai_terms(&searchable, terms)
}

fn matching_ai_terms(searchable: &str, terms: &[String]) -> Vec<String> {
    let searchable = normalize_cjk_ocr_spacing(searchable).to_lowercase();
    terms
        .iter()
        .filter(|term| {
            let term = normalize_cjk_ocr_spacing(term).to_lowercase();
            !term.is_empty() && searchable.contains(&term)
        })
        .cloned()
        .collect()
}

fn search_highlight_terms(query: &str, selected_terms: &[String]) -> Vec<String> {
    let source = if selected_terms.is_empty() {
        query
            .split_whitespace()
            .map(|term| {
                let trimmed = term.trim_matches(|character: char| {
                    matches!(
                        character,
                        '"' | '\'' | '(' | ')' | '+' | '-' | '|' | '*' | '~'
                    )
                });
                trimmed
                    .rsplit_once(':')
                    .map_or(trimmed, |(_, value)| value)
                    .trim()
                    .to_string()
            })
            .collect::<Vec<_>>()
    } else {
        selected_terms.to_vec()
    };
    let mut terms = Vec::new();
    for term in source {
        let normalized = term.trim();
        if !normalized.is_empty()
            && !terms
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(normalized))
        {
            terms.push(normalized.chars().take(128).collect());
        }
        if terms.len() == 16 {
            break;
        }
    }
    terms
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

fn load_files(
    conn: &rusqlite::Connection,
    file_ids: &[i64],
) -> Result<HashMap<i64, (FileInfo, String)>, String> {
    if file_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(file_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut statement = conn
        .prepare(&format!(
            "SELECT f.id, f.folder_id, f.relative_path, f.file_name, f.file_extension, f.file_size_bytes, f.content_hash, f.page_count, f.text_length, f.file_created_at, f.file_modified_at, f.indexed_at, f.index_status, f.index_error, f.text_preview, f.ocr_applied, f.pdf_title, f.pdf_author, f.pdf_subject, f.pdf_keywords, wf.path FROM files f JOIN watched_folders wf ON wf.id = f.folder_id WHERE f.id IN ({placeholders})"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(file_ids), |row| {
            Ok((crate::db::row_to_file_info(row)?, row.get(20)?))
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let value = row.map_err(|error| error.to_string())?;
        Ok((value.0.id, value))
    })
    .collect()
}

#[cfg(test)]
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
    use super::{
        make_snippet, matches_filters, matching_ai_terms, normalize_selected_terms,
        search_highlight_terms, selected_terms_query,
    };
    use crate::models::{FileInfo, SearchFilters};

    fn file_fixture() -> FileInfo {
        FileInfo {
            id: 1,
            folder_id: 2,
            relative_path: "report.pdf".to_string(),
            file_name: "report.pdf".to_string(),
            file_extension: "pdf".to_string(),
            file_size_bytes: 1_024,
            content_hash: "hash".to_string(),
            page_count: Some(1),
            text_length: Some(20),
            file_created_at: None,
            file_modified_at: "2026-07-20T00:00:00".to_string(),
            indexed_at: None,
            index_status: "indexed".to_string(),
            index_error: None,
            text_preview: Some("Compliance report".to_string()),
            ocr_applied: false,
            pdf_title: None,
            pdf_author: None,
            pdf_subject: None,
            pdf_keywords: None,
        }
    }

    #[test]
    fn builds_safe_or_query_from_selected_terms() {
        let terms = vec![
            "SSL certificate".to_string(),
            " TLS certificate ".to_string(),
            "\\\"security | audit\\\"".to_string(),
        ];
        assert_eq!(
            selected_terms_query(&normalize_selected_terms(Some(&terms))),
            Some("(SSL certificate) | (TLS certificate) | (security \\| audit)".to_string())
        );
    }

    #[test]
    fn identifies_case_insensitive_and_cjk_ocr_term_matches() {
        let terms = vec![
            "Network Security".to_string(),
            "网络安全".to_string(),
            "合规报告".to_string(),
        ];
        assert_eq!(
            matching_ai_terms("NETWORK SECURITY / 网 络 安 全 管理办法", &terms),
            vec!["Network Security", "网络安全"]
        );
    }

    #[test]
    fn applies_all_search_filter_boundaries() {
        let file = file_fixture();
        assert!(matches_filters(
            &file,
            Some(&SearchFilters {
                folder_id: Some(2),
                date_from: Some("2026-07-01".to_string()),
                date_to: Some("2026-07-31".to_string()),
                size_min: Some(1_024),
                size_max: Some(1_024),
                file_extension: Some("PDF".to_string()),
            })
        ));
        assert!(!matches_filters(
            &file,
            Some(&SearchFilters {
                folder_id: Some(3),
                date_from: None,
                date_to: None,
                size_min: None,
                size_max: None,
                file_extension: None,
            })
        ));
        assert!(!matches_filters(
            &file,
            Some(&SearchFilters {
                folder_id: None,
                date_from: None,
                date_to: None,
                size_min: Some(1_025),
                size_max: None,
                file_extension: None,
            })
        ));
    }

    #[test]
    fn builds_unicode_snippets_on_character_boundaries() {
        let prefix = "context ".repeat(100);
        let content = format!("{prefix}security review and compliance evidence");
        let snippet = make_snippet(&content, "security");
        assert!(snippet.contains("security review"));
        assert!(snippet.chars().count() <= 320);

        let cjk = format!("{}中国科学院网络安全报告", "前置内容".repeat(100));
        assert!(make_snippet(&cjk, "网络安全").contains("网络安全报告"));
    }

    #[test]
    fn extracts_safe_deduplicated_highlight_terms() {
        assert_eq!(
            search_highlight_terms("name:audit.pdf AUDIT \"风险\"", &[]),
            vec!["audit.pdf", "AUDIT", "风险"]
        );
        assert_eq!(
            search_highlight_terms("ignored", &["supply risk".to_string()]),
            vec!["supply risk"]
        );
    }
}
