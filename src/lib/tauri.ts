import { invoke } from '@tauri-apps/api/core';
import type {
  FileInfo, FolderInfo, FolderConfig, IndexJob,
  SearchResponse, SearchFilters, PaginatedResult, SortConfig, SearchQueryAnalysis,
  RuntimeLogSnapshot, RuntimeLogSource,
  IndexMode,
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

export async function startIndexing(
  folderId?: number,
  ocrAfterIndex: boolean = false,
  mode: IndexMode = 'incremental',
): Promise<number> {
  return invoke('start_indexing', { folderId, ocrAfterIndex, mode });
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
  page: number = 0,
  pageSize: number = 25,
  requestId?: number,
  terms?: string[],
  queryModel?: string,
): Promise<SearchResponse> {
  return invoke('search', { query, terms, queryModel, filters, page, pageSize, requestId });
}

export async function analyzeSearchQuery(query: string): Promise<SearchQueryAnalysis> {
  return invoke('analyze_search_query', { query });
}

export async function getRuntimeLogs(
  source: RuntimeLogSource,
  maxLines: number = 500,
): Promise<RuntimeLogSnapshot> {
  return invoke('get_runtime_logs', { source, maxLines });
}

export async function showInFolder(path: string): Promise<void> {
  return invoke('show_in_folder', { path });
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

// ── OCR ──

export async function checkOcrHealth(): Promise<import('../types').MinerUHealthInfo> {
  return invoke('check_ocr_health');
}

export async function submitOcrTask(fileId: number, returnMd?: boolean): Promise<import('../types').SubmitTaskResponse> {
  return invoke('submit_ocr_task', { fileId, returnMd });
}

export async function queryOcrTask(taskId: string): Promise<import('../types').OcrTaskStatus> {
  return invoke('query_ocr_task', { taskId });
}

export async function getOcrResult(taskId: string, fileId: number): Promise<string> {
  return invoke('get_ocr_result', { taskId, fileId });
}

export async function syncOcrParse(
  fileId: number,
  returnMd?: boolean,
  responseFormatZip?: boolean
): Promise<string> {
  return invoke('sync_ocr_parse', { fileId, returnMd, responseFormatZip });
}

export async function getWindowsOcrStatus(): Promise<import('../types').WindowsOcrStatus> {
  return invoke('get_windows_ocr_status');
}

export async function runWindowsOcr(
  fileId: number,
  taskId: string,
  language?: string
): Promise<string> {
  return invoke('run_windows_ocr', { fileId, taskId, language });
}

export async function getPaddleOcrStatus(): Promise<import('../types').PaddleOcrStatus> {
  return invoke('get_paddle_ocr_status');
}

export async function installPaddleOcr(
  primaryIndex?: import('../types').PaddlePackageIndex,
  fallbackIndex?: import('../types').PaddlePackageIndex,
  deviceMode?: import('../types').PaddleDeviceMode,
): Promise<import('../types').PaddleOcrStatus> {
  return invoke('install_paddle_ocr', { primaryIndex, fallbackIndex, deviceMode });
}

export async function runPaddleOcr(
  fileId: number,
  taskId: string,
  language: string,
  model: string,
): Promise<string> {
  return invoke('run_paddle_ocr', { fileId, taskId, language, model });
}

export async function getRapidOcrStatus(): Promise<import('../types').RapidOcrStatus> {
  return invoke('get_rapid_ocr_status');
}

export async function installRapidOcr(
  deviceMode?: import('../types').RapidDeviceMode,
): Promise<import('../types').RapidOcrStatus> {
  return invoke('install_rapid_ocr', { deviceMode });
}

export async function runRapidOcr(
  fileId: number,
  taskId: string,
  language: string,
  model: string,
): Promise<string> {
  return invoke('run_rapid_ocr', { fileId, taskId, language, model });
}

export async function cancelOcrTask(taskId: string): Promise<boolean> {
  return invoke('cancel_ocr_task', { taskId });
}

export async function cancelAllOcrTasks(): Promise<number> {
  return invoke('cancel_all_ocr_tasks');
}

export async function getOcrOutputDir(): Promise<string> {
  return invoke('get_ocr_output_dir');
}

export async function listOcrCandidates(
  folderId?: number,
  page: number = 0,
  pageSize: number = 50,
  pendingOnly: boolean = true,
): Promise<import('../types').PaginatedResult<import('../types').FileInfo>> {
  return invoke('list_ocr_candidates', { folderId, page, pageSize, pendingOnly });
}

export async function listOcrCandidateRefs(
  folderId?: number,
  afterId: number = 0,
  limit: number = 500,
): Promise<import('../types').OcrCandidateRef[]> {
  return invoke('list_ocr_candidate_refs', { folderId, afterId, limit });
}

// ── Settings ──

export async function getSetting(key: string): Promise<string | null> {
  return invoke('get_setting', { key });
}

export async function setSetting(key: string, value: string): Promise<void> {
  return invoke('set_setting', { key, value });
}

export async function getDbPath(): Promise<string> {
  return invoke('get_db_path');
}

export async function vacuumDatabase(): Promise<string> {
  return invoke('vacuum_database');
}

export async function getOpenAiConfig(): Promise<import('../types').OpenAiConfig> {
  return invoke('get_openai_config');
}

export async function setOpenAiConfig(
  endpoint: string,
  model: string,
  apiKey: string | undefined,
  smartSearchEnabled: boolean,
): Promise<import('../types').OpenAiConfig> {
  return invoke('set_openai_config', { endpoint, model, apiKey, smartSearchEnabled });
}

export async function testOpenAiConnection(): Promise<import('../types').OpenAiConnectionInfo> {
  return invoke('test_openai_connection');
}

export async function getSearchBackendStatus(): Promise<import('../types').SearchBackendStatus> {
  return invoke('get_search_backend_status');
}
