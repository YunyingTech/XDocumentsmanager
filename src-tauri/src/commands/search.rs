use tauri::State;
use crate::db::Database;
use crate::models::{SearchResult, SearchFilters};

#[tauri::command]
pub fn search(
    query: String,
    filters: Option<SearchFilters>,
    limit: Option<i64>,
    db: State<'_, Database>,
) -> Result<Vec<SearchResult>, String> {
    let conn = db.get_connection();
    let limit = limit.unwrap_or(100);

    // Use FTS5 for full-text search
    let fts_query = if query.contains(' ') {
        // Multi-word: wrap each word in quotes for phrase matching
        query.split_whitespace()
            .map(|w| format!("\"{}\"", w.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" OR ")
    } else {
        format!("\"{}\"", query)
    };

    let sql = format!(
        "SELECT f.id, f.folder_id, f.relative_path, f.file_name, f.file_extension, f.file_size_bytes,
                f.content_hash, f.page_count, f.text_length, f.file_created_at, f.file_modified_at,
                f.indexed_at, f.index_status, f.index_error, f.text_preview, f.ocr_applied,
                f.pdf_title, f.pdf_author, f.pdf_subject, f.pdf_keywords,
                wf.path as folder_path,
                fts.rank as score
         FROM files_fts fts
         JOIN files f ON f.id = fts.rowid
         JOIN watched_folders wf ON f.folder_id = wf.id
         WHERE files_fts MATCH ?1
         ORDER BY rank
         LIMIT ?2"
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let results = stmt.query_map(
        rusqlite::params![fts_query, limit],
        |row| {
            let file = crate::db::row_to_file_info(row)?;
            let folder_path: String = row.get(20)?;
            let score: f64 = row.get(21)?;

            // Generate simple snippet from text_preview
            let snippet = file.text_preview.as_deref()
                .unwrap_or("")
                .chars()
                .take(300)
                .collect::<String>();

            // Highlight matching terms
            let snippet = highlight_snippet(&snippet, &query);

            Ok(SearchResult {
                file,
                score,
                snippet,
                folder_path,
            })
        },
    ).map_err(|e| e.to_string())?;

    // Collect results
    let results: Vec<SearchResult> = results
        .filter_map(|r| r.ok())
        .collect();

    // Save search history
    let count = results.len() as i64;
    let _ = conn.execute(
        "INSERT INTO search_history (query_text, result_count) VALUES (?1, ?2)",
        rusqlite::params![query, count],
    );

    Ok(results)
}

fn highlight_snippet(text: &str, query: &str) -> String {
    let mut result = text.to_string();
    for term in query.split_whitespace() {
        let term_lower = term.to_lowercase();
        // Simple case-insensitive highlight with <mark> tags
        if let Some(start) = result.to_lowercase().find(&term_lower) {
            let end = start + term.len();
            result = format!(
                "{}<mark class=\"bg-yellow-200 dark:bg-yellow-800 rounded px-0.5\">{}</mark>{}",
                &result[..start],
                &result[start..end],
                &result[end..],
            );
        }
    }
    result
}
