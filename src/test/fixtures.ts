import type { FileInfo, FolderInfo, SearchResult } from '../types';

export function fileFixture(overrides: Partial<FileInfo> = {}): FileInfo {
  return {
    id: 1,
    folder_id: 10,
    relative_path: 'document.pdf',
    file_name: 'document.pdf',
    file_extension: 'pdf',
    file_size_bytes: 1024,
    content_hash: 'hash',
    page_count: 1,
    text_length: 20,
    file_created_at: '2026-07-20T00:00:00Z',
    file_modified_at: '2026-07-21T00:00:00Z',
    indexed_at: '2026-07-21T00:01:00Z',
    index_status: 'indexed',
    index_error: null,
    text_preview: 'Quarterly compliance report',
    ocr_applied: false,
    pdf_title: null,
    pdf_author: null,
    pdf_subject: null,
    pdf_keywords: null,
    ...overrides,
  };
}

export function folderFixture(overrides: Partial<FolderInfo> = {}): FolderInfo {
  return {
    id: 10,
    path: 'C:\\Documents',
    display_name: 'Documents',
    folder_type: 'local',
    smb_username: null,
    smb_domain: null,
    is_active: true,
    watch_mode: 'manual',
    poll_interval_secs: 300,
    last_scan_at: null,
    last_scan_status: 'never',
    total_files: 0,
    total_size_bytes: 0,
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
    ...overrides,
  };
}

export function searchResultFixture(file = fileFixture()): SearchResult {
  return {
    file,
    score: 1,
    snippet: file.text_preview ?? '',
    folder_path: 'C:\\Documents',
    absolute_path: `C:\\Documents\\${file.file_name}`,
    matched_terms: [],
    match_model: null,
  };
}
