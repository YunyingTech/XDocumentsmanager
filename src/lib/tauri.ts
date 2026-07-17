import { invoke } from '@tauri-apps/api/core';
import type {
  FileInfo, FolderInfo, FolderConfig, IndexJob, IndexProgress,
  SearchResult, SearchFilters, PaginatedResult, SortConfig
} from '../types';

// ── Files ──

export async function listFiles(
  folderId: number,
  sort: SortConfig,
  page: number,
  pageSize: number = 50
): Promise<PaginatedResult<FileInfo>> {
  return invoke('list_files', { folderId, sort, page, pageSize });
}

export async function getFile(fileId: number): Promise<FileInfo> {
  return invoke('get_file', { fileId });
}

export async function deleteFileRecord(fileId: number): Promise<void> {
  return invoke('delete_file_record', { fileId });
}

export async function getFileCount(): Promise<number> {
  return invoke('get_file_count');
}

// ── Folders ──

export async function addFolder(path: string, config?: FolderConfig): Promise<FolderInfo> {
  return invoke('add_folder', { path, config });
}

export async function removeFolder(folderId: number): Promise<void> {
  return invoke('remove_folder', { folderId });
}

export async function listFolders(): Promise<FolderInfo[]> {
  return invoke('list_folders');
}

export async function updateFolder(folderId: number, config: Partial<FolderConfig>): Promise<FolderInfo> {
  return invoke('update_folder', { folderId, config });
}

// ── Indexing ──

export async function startIndexing(folderId?: number): Promise<number> {
  return invoke('start_indexing', { folderId });
}

export async function pauseIndexing(jobId: number): Promise<void> {
  return invoke('pause_indexing', { jobId });
}

export async function getIndexStatus(): Promise<IndexJob | null> {
  return invoke('get_index_status');
}

export async function reindexFile(fileId: number): Promise<void> {
  return invoke('reindex_file', { fileId });
}

// ── Search ──

export async function search(
  query: string,
  filters?: SearchFilters,
  limit: number = 100
): Promise<SearchResult[]> {
  return invoke('search', { query, filters, limit });
}

// ── Viewer ──

export async function readFileBytes(path: string): Promise<number[]> {
  return invoke('read_file_bytes', { path });
}

export async function readFileBytesRange(
  path: string,
  start: number,
  end: number
): Promise<number[]> {
  return invoke('read_file_bytes_range', { path, start, end });
}

// ── Settings ──

export async function getSetting(key: string): Promise<string | null> {
  return invoke('get_setting', { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  return invoke('set_setting', { key, value });
}
