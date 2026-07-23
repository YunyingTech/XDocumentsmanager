import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import * as api from './tauri';

describe('Tauri command bindings', () => {
  beforeEach(() => invoke.mockReset());

  it('forwards the index-and-OCR flag with the expected camelCase argument', async () => {
    invoke.mockResolvedValue(42);
    await expect(api.startIndexing(7, true)).resolves.toBe(42);
    expect(invoke).toHaveBeenCalledWith('start_indexing', { folderId: 7, ocrAfterIndex: true, mode: 'incremental' });
  });

  it('keeps normal indexing backward compatible', async () => {
    invoke.mockResolvedValue(43);
    await api.startIndexing(7);
    expect(invoke).toHaveBeenCalledWith('start_indexing', { folderId: 7, ocrAfterIndex: false, mode: 'incremental' });
  });

  it('forwards explicit full re-indexing mode', async () => {
    invoke.mockResolvedValue(44);
    await api.startIndexing(7, false, 'full');
    expect(invoke).toHaveBeenCalledWith('start_indexing', { folderId: 7, ocrAfterIndex: false, mode: 'full' });
  });

  it('forwards AI terms and the model used to generate them', async () => {
    invoke.mockResolvedValue({ results: [], elapsed_ms: 1 });
    await api.search('risk report', { folder_id: 3 }, 25, 9, ['audit', 'risk'], 'gpt-test');
    expect(invoke).toHaveBeenCalledWith('search', {
      query: 'risk report',
      terms: ['audit', 'risk'],
      queryModel: 'gpt-test',
      filters: { folder_id: 3 },
      limit: 25,
      requestId: 9,
    });
  });

  it('binds OCR cancellation, candidate listing, and byte ranges', async () => {
    invoke.mockResolvedValueOnce(2).mockResolvedValueOnce([]).mockResolvedValueOnce([1, 2]);
    await expect(api.cancelAllOcrTasks()).resolves.toBe(2);
    await api.listOcrCandidateRefs(11, 100, 250);
    await api.readFileBytesRange('C:\\docs\\a.pdf', 10, 12);
    expect(invoke.mock.calls).toEqual([
      ['cancel_all_ocr_tasks'],
      ['list_ocr_candidate_refs', { folderId: 11, afterId: 100, limit: 250 }],
      ['read_file_bytes_range', { path: 'C:\\docs\\a.pdf', start: 10, end: 12 }],
    ]);
  });

  it('keeps every exported backend binding connected to its registered command', async () => {
    invoke.mockResolvedValue(undefined);
    await api.listFiles(1, { field: 'file_name', direction: 'asc' }, 0, 25);
    await api.getFile(1);
    await api.deleteFileRecord(1);
    await api.getFileCount();
    await api.addFolder('C:\\docs', { display_name: 'Docs' });
    await api.removeFolder(1);
    await api.listFolders();
    await api.updateFolder(1, { watch_mode: 'manual' });
    await api.pauseIndexing(2);
    await api.getIndexStatus();
    await api.reindexFile(1);
    await api.analyzeSearchQuery('risk');
    await api.getRuntimeLogs('application', 20);
    await api.showInFolder('C:\\docs\\a.pdf');
    await api.readFileBytes('C:\\docs\\a.pdf');
    await api.checkOcrHealth();
    await api.submitOcrTask(1, true);
    await api.queryOcrTask('task');
    await api.getOcrResult('task', 1);
    await api.syncOcrParse(1, true, false);
    await api.getWindowsOcrStatus();
    await api.runWindowsOcr(1, 'task', 'auto');
    await api.getPaddleOcrStatus();
    await api.installPaddleOcr();
    await api.runPaddleOcr(1, 'task', 'ch', 'mobile');
    await api.cancelOcrTask('task');
    await api.getOcrOutputDir();
    await api.listOcrCandidates(1, 0, 25);
    await api.getSetting('theme');
    await api.setSetting('theme', 'dark');
    await api.getDbPath();
    await api.vacuumDatabase();
    await api.getOpenAiConfig();
    await api.setOpenAiConfig('http://localhost/v1', 'model', 'key', true);
    await api.testOpenAiConnection();
    await api.getSearchBackendStatus();

    const commands = new Set(invoke.mock.calls.map(([command]) => command));
    expect(commands).toEqual(new Set([
      'list_files', 'get_file', 'delete_file_record', 'get_file_count',
      'add_folder', 'remove_folder', 'list_folders', 'update_folder',
      'pause_indexing', 'get_index_status', 'reindex_file', 'analyze_search_query',
      'get_runtime_logs', 'show_in_folder', 'read_file_bytes', 'check_ocr_health',
      'submit_ocr_task', 'query_ocr_task', 'get_ocr_result', 'sync_ocr_parse',
      'get_windows_ocr_status', 'run_windows_ocr', 'get_paddle_ocr_status',
      'install_paddle_ocr', 'run_paddle_ocr', 'cancel_ocr_task',
      'get_ocr_output_dir', 'list_ocr_candidates', 'get_setting', 'set_setting',
      'get_db_path', 'vacuum_database', 'get_openai_config', 'set_openai_config',
      'test_openai_connection', 'get_search_backend_status',
    ]));
  });
});
