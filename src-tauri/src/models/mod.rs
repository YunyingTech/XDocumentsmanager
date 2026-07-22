use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub id: i64,
    pub folder_id: i64,
    pub relative_path: String,
    pub file_name: String,
    pub file_extension: String,
    pub file_size_bytes: i64,
    pub content_hash: String,
    pub page_count: Option<i32>,
    pub text_length: Option<i32>,
    pub file_created_at: Option<String>,
    pub file_modified_at: String,
    pub indexed_at: Option<String>,
    pub index_status: String,
    pub index_error: Option<String>,
    pub text_preview: Option<String>,
    pub ocr_applied: bool,
    pub pdf_title: Option<String>,
    pub pdf_author: Option<String>,
    pub pdf_subject: Option<String>,
    pub pdf_keywords: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderInfo {
    pub id: i64,
    pub path: String,
    pub display_name: Option<String>,
    pub folder_type: String,
    pub smb_username: Option<String>,
    pub smb_domain: Option<String>,
    pub is_active: bool,
    pub watch_mode: String,
    pub poll_interval_secs: i32,
    pub last_scan_at: Option<String>,
    pub last_scan_status: String,
    pub total_files: i64,
    pub total_size_bytes: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderConfig {
    pub display_name: Option<String>,
    pub folder_type: Option<String>,
    pub smb_username: Option<String>,
    pub smb_domain: Option<String>,
    pub smb_password: Option<String>,
    pub watch_mode: Option<String>,
    pub poll_interval_secs: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexJob {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub job_type: String,
    pub status: String,
    pub files_total: i64,
    pub files_processed: i64,
    pub files_indexed: i64,
    pub files_skipped: i64,
    pub files_errors: i64,
    pub bytes_processed: i64,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexProgress {
    pub job_id: i64,
    pub folder_id: Option<i64>,
    pub status: String,
    pub files_total: i64,
    pub files_processed: i64,
    pub files_indexed: i64,
    pub files_skipped: i64,
    pub files_errors: i64,
    pub bytes_processed: i64,
    pub current_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub file: FileInfo,
    pub score: f64,
    pub snippet: String,
    pub folder_path: String,
    pub absolute_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchQueryAnalysis {
    pub terms: Vec<String>,
    pub elapsed_ms: u64,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAiConfig {
    pub endpoint: String,
    pub model: String,
    pub api_key_configured: bool,
    pub smart_search_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAiConnectionInfo {
    pub connected: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchBackendStatus {
    pub backend: String,
    pub connected: bool,
    pub endpoint: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchFilters {
    pub folder_id: Option<i64>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub size_min: Option<i64>,
    pub size_max: Option<i64>,
    pub file_extension: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SortConfig {
    pub field: String,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedFile {
    pub id: i64,
    pub path: String,
    pub file_size: i64,
    pub mtime: String,
    pub md5: String,
    pub status: String,
    pub ocr_time: Option<String>,
    pub index_time: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaginatedResult<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
    pub total_pages: i64,
}
