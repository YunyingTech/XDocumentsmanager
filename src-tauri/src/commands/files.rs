use tauri::State;
use crate::db::Database;
use crate::models::{FileInfo, SortConfig, PaginatedResult};
use crate::search::SearchEngine;

#[tauri::command]
pub fn list_files(
    folder_id: i64,
    sort: SortConfig,
    page: i64,
    page_size: i64,
    db: State<'_, Database>,
) -> Result<PaginatedResult<FileInfo>, String> {
    let conn = db.get_connection();
    let page = page.max(0);
    let page_size = page_size.clamp(1, 500);

    let (sort_field, sort_dir) = sort_clause(&sort);

    // Get total count
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM files WHERE folder_id = ?1",
        [folder_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;

    let total_pages = if total == 0 { 0 } else { ((total as f64) / (page_size as f64)).ceil() as i64 };
    let offset = page * page_size;

    // Use parameterized query with validated sort
    let query = format!(
        "SELECT id, folder_id, relative_path, file_name, file_extension, file_size_bytes,
                content_hash, page_count, text_length, file_created_at, file_modified_at,
                indexed_at, index_status, index_error, text_preview, ocr_applied,
                pdf_title, pdf_author, pdf_subject, pdf_keywords
         FROM files WHERE folder_id = ?1
         ORDER BY {} {}, id {}
         LIMIT ?2 OFFSET ?3",
        sort_field, sort_dir, sort_dir
    );

    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;

    let items = stmt.query_map(
        rusqlite::params![folder_id, page_size, offset],
        |row| crate::db::row_to_file_info(row),
    ).map_err(|e| e.to_string())?
    .filter_map(|r| r.ok())
    .collect();

    Ok(PaginatedResult {
        items,
        total,
        page,
        page_size,
        total_pages,
    })
}

fn sort_clause(sort: &SortConfig) -> (&'static str, &'static str) {
    let field = match sort.field.as_str() {
        "file_name" => "file_name COLLATE NOCASE",
        "file_size_bytes" => "file_size_bytes",
        "file_modified_at" => "file_modified_at",
        "page_count" => "page_count",
        "index_status" => "index_status",
        _ => "file_modified_at",
    };
    let direction = if sort.direction == "asc" { "ASC" } else { "DESC" };
    (field, direction)
}

#[cfg(test)]
mod tests {
    use super::sort_clause;
    use crate::models::SortConfig;

    #[test]
    fn validates_sort_sql_components() {
        let name = SortConfig { field: "file_name".into(), direction: "asc".into() };
        assert_eq!(sort_clause(&name), ("file_name COLLATE NOCASE", "ASC"));
        let hostile = SortConfig { field: "id; DROP TABLE files".into(), direction: "ASC; DROP TABLE files".into() };
        assert_eq!(sort_clause(&hostile), ("file_modified_at", "DESC"));
    }
}

#[tauri::command]
pub fn get_file(file_id: i64, db: State<'_, Database>) -> Result<FileInfo, String> {
    let conn = db.get_connection();
    let mut stmt = conn.prepare(
        "SELECT id, folder_id, relative_path, file_name, file_extension, file_size_bytes,
                content_hash, page_count, text_length, file_created_at, file_modified_at,
                indexed_at, index_status, index_error, text_preview, ocr_applied,
                pdf_title, pdf_author, pdf_subject, pdf_keywords
         FROM files WHERE id = ?1"
    ).map_err(|e| e.to_string())?;

    stmt.query_row([file_id], |row| crate::db::row_to_file_info(row))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_file_record(file_id: i64, db: State<'_, Database>, engine: State<'_, SearchEngine>) -> Result<(), String> {
    let conn = db.get_connection();
    conn.execute("DELETE FROM files WHERE id = ?1", [file_id])
        .map_err(|e| e.to_string())?;
    engine.delete_file(file_id)?;
    Ok(())
}

#[tauri::command]
pub fn get_file_count(db: State<'_, Database>) -> Result<i64, String> {
    let conn = db.get_connection();
    conn.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}
