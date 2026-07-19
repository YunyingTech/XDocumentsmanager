// Type definitions shared between frontend and backend

export interface FileInfo {
  id: number;
  folder_id: number;
  relative_path: string;
  file_name: string;
  file_extension: string;
  file_size_bytes: number;
  content_hash: string;
  page_count: number | null;
  text_length: number | null;
  file_created_at: string | null;
  file_modified_at: string;
  indexed_at: string | null;
  index_status: 'pending' | 'indexing' | 'indexed' | 'error' | 'skipped';
  index_error: string | null;
  text_preview: string | null;
  ocr_applied: boolean;
  pdf_title: string | null;
  pdf_author: string | null;
  pdf_subject: string | null;
  pdf_keywords: string | null;
}

export interface FolderInfo {
  id: number;
  path: string;
  display_name: string | null;
  folder_type: 'local' | 'smb';
  smb_username: string | null;
  smb_domain: string | null;
  is_active: boolean;
  watch_mode: 'auto' | 'polling' | 'manual';
  poll_interval_secs: number;
  last_scan_at: string | null;
  last_scan_status: 'never' | 'running' | 'completed' | 'error';
  total_files: number;
  total_size_bytes: number;
  created_at: string;
  updated_at: string;
}

export interface FolderConfig {
  display_name?: string;
  folder_type?: 'local' | 'smb';
  smb_username?: string;
  smb_domain?: string;
  smb_password?: string;
  watch_mode?: 'auto' | 'polling' | 'manual';
  poll_interval_secs?: number;
}

export interface IndexJob {
  id: number;
  folder_id: number | null;
  job_type: 'full_scan' | 'incremental' | 'manual_reindex';
  status: 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'error';
  files_total: number;
  files_processed: number;
  files_indexed: number;
  files_skipped: number;
  files_errors: number;
  bytes_processed: number;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

export interface IndexProgress {
  job_id: number;
  folder_id: number | null;
  status: string;
  files_total: number;
  files_processed: number;
  files_indexed: number;
  files_skipped: number;
  files_errors: number;
  bytes_processed: number;
  current_file: string | null;
}

export interface SearchResult {
  file: FileInfo;
  score: number;
  snippet: string;
  folder_path: string;
}

export interface SearchFilters {
  folder_id?: number;
  date_from?: string;
  date_to?: string;
  size_min?: number;
  size_max?: number;
  file_extension?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export type FileSortField = 'file_name' | 'file_size_bytes' | 'file_modified_at' | 'page_count' | 'index_status';
export type SortDirection = 'asc' | 'desc';

export interface SortConfig {
  field: FileSortField;
  direction: SortDirection;
}

export interface AppSettings {
  index_location: string;
  max_file_size_mb: number;
  indexer_threads: number;
  poll_interval_secs: number;
  theme: 'light' | 'dark' | 'system';
  default_view: 'table' | 'grid';
  ocr_enabled: boolean;
  ocr_languages: string;
}

// ── OCR (MinerU API) ──

export interface MinerUHealthInfo {
  protocol_version: string;
  processing_window_size: number;
  max_concurrent_requests: number;
  connected: boolean;
  api_url: string;
}

export interface SubmitTaskResponse {
  task_id: string;
}

export interface OcrTaskStatus {
  task_id: string;
  status: string;
  queued_ahead?: number;
  progress?: number;
  error_message?: string;
}
