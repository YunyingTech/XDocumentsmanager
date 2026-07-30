import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkOcrHealth: vi.fn(),
  submitOcrTask: vi.fn(),
  queryOcrTask: vi.fn(),
  getOcrResult: vi.fn(),
  syncOcrParse: vi.fn(),
  getWindowsOcrStatus: vi.fn(),
  runWindowsOcr: vi.fn(),
  getPaddleOcrStatus: vi.fn(),
  installPaddleOcr: vi.fn(),
  runPaddleOcr: vi.fn(),
  getRapidOcrStatus: vi.fn(),
  installRapidOcr: vi.fn(),
  runRapidOcr: vi.fn(),
  cancelOcrTask: vi.fn(),
  cancelAllOcrTasks: vi.fn(),
  listOcrCandidates: vi.fn(),
  listOcrCandidateRefs: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock('../lib/tauri', () => mocks);

import { useOcrStore } from './ocrStore';
import { fileFixture } from '../test/fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const emptyCandidates = { items: [], total: 0, page: 0, page_size: 50, total_pages: 0 };

describe('OCR store', () => {
  beforeEach(() => {
    useOcrStore.getState().stopPolling();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listOcrCandidates.mockResolvedValue(emptyCandidates);
    mocks.cancelAllOcrTasks.mockResolvedValue(0);
    mocks.getSetting.mockResolvedValue(null);
    useOcrStore.setState({
      health: null,
      windowsStatus: null,
      paddleStatus: null,
      rapidStatus: null,
      healthChecking: false,
      paddleInstallProgress: null,
      isInstallingPaddle: false,
      rapidInstallProgress: null,
      isInstallingRapid: false,
      candidates: [],
      loadingCandidates: false,
      page: 0,
      pageSize: 50,
      totalCandidates: 0,
      totalPages: 0,
      selectedFileIds: new Set(),
      tasks: [],
      isSubmitting: false,
      bulkOcrRunning: false,
      bulkOcrQueued: 0,
      polling: false,
      pollTimer: null,
      apiUrl: 'http://127.0.0.1:8000',
      outputDir: '',
      engine: 'mineru',
      windowsLanguage: 'auto',
      paddleLanguage: 'ch',
      paddleModel: 'PP-OCRv5_mobile',
      paddleDeviceMode: 'auto',
      paddlePypiPrimary: 'ustc',
      paddlePypiFallback: 'tsinghua',
      rapidLanguage: 'ch',
      rapidModel: 'PP-OCRv6_small',
      rapidDeviceMode: 'auto',
      rapidWorkerCount: 3,
      rapidPypiPrimary: 'ustc',
      rapidPypiFallback: 'tsinghua',
    });
  });

  afterEach(() => useOcrStore.getState().stopPolling());

  it('runs at most two Windows OCR files concurrently and keeps the full queue visible', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    mocks.runWindowsOcr.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValueOnce('three.md');
    useOcrStore.setState({ engine: 'windows' });

    const submission = useOcrStore.getState().submitFileBatch([
      { id: 1, file_name: 'one.pdf' },
      { id: 2, file_name: 'two.pdf' },
      { id: 3, file_name: 'three.pdf' },
    ]);
    await vi.waitFor(() => expect(mocks.runWindowsOcr).toHaveBeenCalledTimes(2));

    expect(useOcrStore.getState().tasks).toHaveLength(3);
    expect(useOcrStore.getState().tasks.map((task) => task.status)).toEqual(['running', 'running', 'queued']);
    first.resolve('one.md');
    await vi.waitFor(() => expect(mocks.runWindowsOcr).toHaveBeenCalledTimes(3));
    second.resolve('two.md');
    await submission;

    expect(useOcrStore.getState().tasks.map((task) => task.status)).toEqual(['completed', 'completed', 'completed']);
    expect(useOcrStore.getState().isSubmitting).toBe(false);
  });

  it('runs three RapidOCR workers by default and keeps the remaining queue visible', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    mocks.runRapidOcr
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)
      .mockResolvedValueOnce('four_rapid.md');
    useOcrStore.setState({ engine: 'rapid' });

    const submission = useOcrStore.getState().submitFileBatch([
      { id: 1, file_name: 'one.pdf' },
      { id: 2, file_name: 'two.pdf' },
      { id: 3, file_name: 'three.pdf' },
      { id: 4, file_name: 'four.pdf' },
    ]);
    await vi.waitFor(() => expect(mocks.runRapidOcr).toHaveBeenCalledTimes(3));
    expect(useOcrStore.getState().tasks.map((task) => task.status)).toEqual(['running', 'running', 'running', 'queued']);
    expect(mocks.runRapidOcr).toHaveBeenCalledWith(1, expect.any(String), 'ch', 'PP-OCRv6_small');

    first.resolve('one_rapid.md');
    await vi.waitFor(() => expect(mocks.runRapidOcr).toHaveBeenCalledTimes(4));
    second.resolve('two_rapid.md');
    third.resolve('three_rapid.md');
    await submission;
    expect(useOcrStore.getState().tasks.every((task) => task.status === 'completed')).toBe(true);
  });

  it('honors a lower configured RapidOCR worker count', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    mocks.runRapidOcr
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce('three_rapid.md');
    useOcrStore.setState({ engine: 'rapid', rapidWorkerCount: 2 });

    const submission = useOcrStore.getState().submitFileBatch([
      { id: 1, file_name: 'one.pdf' },
      { id: 2, file_name: 'two.pdf' },
      { id: 3, file_name: 'three.pdf' },
    ]);
    await vi.waitFor(() => expect(mocks.runRapidOcr).toHaveBeenCalledTimes(2));
    expect(useOcrStore.getState().tasks.map((task) => task.status)).toEqual(['running', 'running', 'queued']);

    first.resolve('one_rapid.md');
    await vi.waitFor(() => expect(mocks.runRapidOcr).toHaveBeenCalledTimes(3));
    second.resolve('two_rapid.md');
    await submission;
  });

  it('uses RapidOCR as the settings fallback and routes its health check', async () => {
    await useOcrStore.getState().loadSettings();
    expect(useOcrStore.getState().engine).toBe('rapid');
    expect(useOcrStore.getState().rapidWorkerCount).toBe(3);

    mocks.getRapidOcrStatus.mockResolvedValue({
      available: true,
      active_provider: 'DmlExecutionProvider',
      accelerated: true,
    });
    await useOcrStore.getState().checkHealth();
    expect(mocks.getRapidOcrStatus).toHaveBeenCalledOnce();
    expect(useOcrStore.getState().rapidStatus).toMatchObject({
      available: true,
      active_provider: 'DmlExecutionProvider',
      accelerated: true,
    });
  });

  it('cancels running and queued Windows OCR tasks without starting the remaining queue', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    mocks.runWindowsOcr.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mocks.cancelAllOcrTasks.mockResolvedValue(2);
    useOcrStore.setState({ engine: 'windows' });

    const submission = useOcrStore.getState().submitFileBatch([
      { id: 1, file_name: 'one.pdf' },
      { id: 2, file_name: 'two.pdf' },
      { id: 3, file_name: 'three.pdf' },
    ]);
    await vi.waitFor(() => expect(mocks.runWindowsOcr).toHaveBeenCalledTimes(2));
    await useOcrStore.getState().cancelAllTasks();

    expect(mocks.cancelAllOcrTasks).toHaveBeenCalledOnce();
    expect(useOcrStore.getState().tasks.every((task) => task.status === 'cancelled')).toBe(true);
    first.resolve('one.md');
    second.resolve('two.md');
    await submission;
    expect(mocks.runWindowsOcr).toHaveBeenCalledTimes(2);
    expect(useOcrStore.getState().isSubmitting).toBe(false);
  });

  it('does not restart MinerU polling after all tasks are cancelled during submission', async () => {
    const remoteSubmission = deferred<{ task_id: string }>();
    mocks.submitOcrTask.mockReturnValueOnce(remoteSubmission.promise);

    const submission = useOcrStore.getState().submitFileBatch([
      { id: 1, file_name: 'one.pdf' },
      { id: 2, file_name: 'two.pdf' },
    ]);
    await vi.waitFor(() => expect(mocks.submitOcrTask).toHaveBeenCalledOnce());
    await useOcrStore.getState().cancelAllTasks();
    remoteSubmission.resolve({ task_id: 'remote-1' });
    await submission;

    expect(mocks.submitOcrTask).toHaveBeenCalledOnce();
    expect(useOcrStore.getState().tasks.every((task) => task.status === 'cancelled')).toBe(true);
    expect(useOcrStore.getState().polling).toBe(false);
  });

  it('downloads and records a completed MinerU result while polling', async () => {
    mocks.queryOcrTask.mockResolvedValue({
      task_id: 'remote-1',
      status: 'completed',
      queued_ahead: 0,
      progress: 100,
      error_message: null,
    });
    mocks.getOcrResult.mockResolvedValue('C:\\OCR\\one.md');
    useOcrStore.setState({
      tasks: [{
        taskId: 'remote-1',
        fileId: 1,
        fileName: 'one.pdf',
        status: 'queued',
        queuedAhead: 0,
        progress: 0,
        submittedAt: 1,
        engine: 'mineru',
      }],
    });

    await useOcrStore.getState().pollAllTasks();

    expect(mocks.getOcrResult).toHaveBeenCalledWith('remote-1', 1);
    expect(useOcrStore.getState().tasks[0]).toMatchObject({
      status: 'completed',
      progress: 100,
      resultPath: 'C:\\OCR\\one.md',
    });
  });

  it('loads saved settings before queueing pending OCR files in a folder', async () => {
    const settings: Record<string, string> = {
      ocr_engine: 'windows',
      windows_ocr_language: 'zh-Hans-CN',
    };
    mocks.getSetting.mockImplementation((key: string) => Promise.resolve(settings[key] ?? null));
    mocks.listOcrCandidateRefs
      .mockResolvedValueOnce([
        { id: 4, file_name: 'four.pdf' },
        { id: 5, file_name: 'five.pdf' },
      ])
      .mockResolvedValueOnce([]);
    mocks.runWindowsOcr.mockResolvedValue('result.md');

    await expect(useOcrStore.getState().queueFolderOcr(12)).resolves.toBe(2);

    expect(mocks.listOcrCandidateRefs).toHaveBeenCalledWith(12, 0, 100);
    expect(mocks.runWindowsOcr).toHaveBeenCalledTimes(2);
    expect(mocks.runWindowsOcr).toHaveBeenCalledWith(expect.any(Number), expect.any(String), 'zh-Hans-CN');
    expect(useOcrStore.getState().tasks.every((task) => task.status === 'completed')).toBe(true);
  });

  it('does not start a duplicate automatic OCR pass for the same folder', async () => {
    const running = deferred<string>();
    mocks.getSetting.mockImplementation((key: string) => Promise.resolve(key === 'ocr_engine' ? 'windows' : null));
    mocks.listOcrCandidateRefs
      .mockResolvedValueOnce([{ id: 8, file_name: 'eight.pdf' }])
      .mockResolvedValueOnce([]);
    mocks.runWindowsOcr.mockReturnValue(running.promise);

    const firstPass = useOcrStore.getState().queueFolderOcr(21);
    await vi.waitFor(() => expect(mocks.runWindowsOcr).toHaveBeenCalledOnce());
    await expect(useOcrStore.getState().queueFolderOcr(21)).resolves.toBe(0);
    running.resolve('eight.md');
    await expect(firstPass).resolves.toBe(1);
    expect(mocks.listOcrCandidateRefs).toHaveBeenCalledTimes(2);
  });

  it('streams every pending OCR file beyond the 100-file batch size', async () => {
    const files = Array.from({ length: 205 }, (_, index) => ({
      id: index + 1,
      file_name: `${index + 1}.pdf`,
    }));
    mocks.getSetting.mockImplementation((key: string) =>
      Promise.resolve(key === 'ocr_engine' ? 'windows' : null)
    );
    mocks.listOcrCandidateRefs.mockImplementation(
      (_folderId: number | undefined, afterId: number, limit: number) =>
        Promise.resolve(files.filter((file) => file.id > afterId).slice(0, limit))
    );
    mocks.runWindowsOcr.mockResolvedValue('result.md');
    mocks.listOcrCandidates.mockResolvedValue({ ...emptyCandidates, total: 205 });

    await expect(useOcrStore.getState().queueAllOcr()).resolves.toBe(205);

    expect(mocks.runWindowsOcr).toHaveBeenCalledTimes(205);
    expect(mocks.listOcrCandidateRefs).toHaveBeenNthCalledWith(1, undefined, 0, 100);
    expect(mocks.listOcrCandidateRefs).toHaveBeenNthCalledWith(2, undefined, 100, 100);
    expect(mocks.listOcrCandidateRefs).toHaveBeenNthCalledWith(3, undefined, 200, 100);
    expect(mocks.listOcrCandidateRefs).toHaveBeenNthCalledWith(4, undefined, 205, 100);
    expect(useOcrStore.getState()).toMatchObject({
      bulkOcrRunning: false,
      bulkOcrQueued: 0,
    });
  });

  it('decrements the bulk task count as each OCR file completes', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    mocks.listOcrCandidates.mockResolvedValue({ ...emptyCandidates, total: 2 });
    mocks.listOcrCandidateRefs
      .mockResolvedValueOnce([
        { id: 1, file_name: 'one.pdf' },
        { id: 2, file_name: 'two.pdf' },
      ])
      .mockResolvedValueOnce([]);
    mocks.runRapidOcr
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const bulkRun = useOcrStore.getState().queueAllOcr();
    await vi.waitFor(() => expect(mocks.runRapidOcr).toHaveBeenCalledTimes(2));
    expect(useOcrStore.getState().bulkOcrQueued).toBe(2);

    first.resolve('one.md');
    await vi.waitFor(() => expect(useOcrStore.getState().bulkOcrQueued).toBe(1));
    second.resolve('two.md');
    await expect(bulkRun).resolves.toBe(2);
    expect(useOcrStore.getState()).toMatchObject({ bulkOcrRunning: false, bulkOcrQueued: 0 });
  });

  it('stops a bulk OCR run before fetching the next 100-file batch when cancelled', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    mocks.getSetting.mockImplementation((key: string) =>
      Promise.resolve(key === 'ocr_engine' ? 'windows' : null)
    );
    mocks.listOcrCandidateRefs.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({ id: index + 1, file_name: `${index + 1}.pdf` }))
    );
    mocks.runWindowsOcr.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const bulkRun = useOcrStore.getState().queueAllOcr();
    await vi.waitFor(() => expect(mocks.runWindowsOcr).toHaveBeenCalledTimes(2));
    await useOcrStore.getState().cancelAllTasks();
    first.resolve('one.md');
    second.resolve('two.md');

    await expect(bulkRun).resolves.toBe(100);
    expect(mocks.listOcrCandidateRefs).toHaveBeenCalledOnce();
    expect(mocks.runWindowsOcr).toHaveBeenCalledTimes(2);
    expect(useOcrStore.getState().bulkOcrRunning).toBe(false);
  });

  it('routes health checks to the selected engine and reports backend failures', async () => {
    mocks.getWindowsOcrStatus.mockResolvedValue({ available: true, languages: [], error: null });
    useOcrStore.setState({ engine: 'windows' });
    await useOcrStore.getState().checkHealth();
    expect(useOcrStore.getState().windowsStatus?.available).toBe(true);

    mocks.getPaddleOcrStatus.mockRejectedValue(new Error('python missing'));
    useOcrStore.setState({ engine: 'paddle' });
    await useOcrStore.getState().checkHealth();
    expect(useOcrStore.getState().paddleStatus).toMatchObject({ available: false, error: 'Error: python missing' });

    mocks.checkOcrHealth.mockRejectedValue(new Error('offline'));
    useOcrStore.setState({ engine: 'mineru' });
    await useOcrStore.getState().checkHealth();
    expect(useOcrStore.getState().health).toMatchObject({ connected: false, api_url: 'http://127.0.0.1:8000' });
    expect(useOcrStore.getState().healthChecking).toBe(false);
  });

  it('tracks managed PaddleOCR installation progress and completion', async () => {
    const installation = deferred<import('../types').PaddleOcrStatus>();
    mocks.installPaddleOcr.mockReturnValue(installation.promise);

    const pending = useOcrStore.getState().installPaddle();
    expect(mocks.installPaddleOcr).toHaveBeenCalledWith('ustc', 'tsinghua', 'auto');
    expect(useOcrStore.getState()).toMatchObject({
      isInstallingPaddle: true,
      paddleInstallProgress: { stage: 'preparing', progress: 0 },
    });

    useOcrStore.getState().updatePaddleInstallProgress({
      stage: 'installing',
      progress: 40,
      message: 'Installing dependencies',
    });
    expect(useOcrStore.getState()).toMatchObject({
      isInstallingPaddle: true,
      paddleInstallProgress: { stage: 'installing', progress: 40 },
    });

    installation.resolve({
      available: true,
      python_path: 'C:\\runtime\\python.exe',
      managed: true,
      install_supported: true,
      install_required: false,
      runtime_version: '3',
      paddle_version: '3.3.1',
      paddleocr_version: '3.3.1',
      requested_device_mode: 'auto',
      active_device: 'gpu:0',
      runtime_profile: 'cu126',
      gpu_detected: true,
      gpu_compatible: true,
      gpu_runtime_installed: true,
      gpu_name: 'NVIDIA RTX 4070',
      gpu_compute_capability: '8.9',
      gpu_driver_version: '580.88',
      cuda_version: '12.6',
      cudnn_version: '9.5',
      fallback_reason: null,
      error: null,
    });
    await pending;
    expect(useOcrStore.getState()).toMatchObject({
      isInstallingPaddle: false,
      paddleStatus: { available: true, managed: true, runtime_version: '3', active_device: 'gpu:0' },
    });
  });

  it('loads and saves Paddle runtime and package source preferences', async () => {
    const settings: Record<string, string> = {
      paddle_device_mode: 'cuda12',
      paddle_pypi_primary: 'tsinghua',
      paddle_pypi_fallback: 'official',
    };
    mocks.getSetting.mockImplementation((key: string) => Promise.resolve(settings[key] ?? null));

    await useOcrStore.getState().loadSettings();
    expect(useOcrStore.getState()).toMatchObject({
      paddlePypiPrimary: 'tsinghua',
      paddlePypiFallback: 'official',
      paddleDeviceMode: 'cuda12',
    });

    await useOcrStore.getState().savePaddlePypiPrimary('ustc');
    await useOcrStore.getState().savePaddlePypiFallback('tsinghua');
    useOcrStore.setState({ engine: 'mineru' });
    await useOcrStore.getState().savePaddleDeviceMode('cpu');
    expect(mocks.setSetting).toHaveBeenCalledWith('paddle_pypi_primary', 'ustc');
    expect(mocks.setSetting).toHaveBeenCalledWith('paddle_pypi_fallback', 'tsinghua');
    expect(mocks.setSetting).toHaveBeenCalledWith('paddle_device_mode', 'cpu');
  });

  it('loads, paginates, selects, and clears OCR candidates', async () => {
    const candidates = [fileFixture({ id: 1 }), fileFixture({ id: 2 })];
    mocks.listOcrCandidates.mockResolvedValue({
      items: candidates,
      total: 12,
      page: 1,
      page_size: 2,
      total_pages: 6,
    });
    useOcrStore.getState().setPageSize(2);
    useOcrStore.getState().setPage(1);
    await useOcrStore.getState().loadCandidates(3);

    expect(mocks.listOcrCandidates).toHaveBeenCalledWith(3, 1, 2, true);
    expect(useOcrStore.getState()).toMatchObject({ totalCandidates: 12, totalPages: 6 });
    useOcrStore.getState().selectAll();
    expect([...useOcrStore.getState().selectedFileIds]).toEqual([1, 2]);
    useOcrStore.getState().toggleFile(1);
    expect([...useOcrStore.getState().selectedFileIds]).toEqual([2]);
    useOcrStore.getState().deselectAll();
    expect(useOcrStore.getState().selectedFileIds.size).toBe(0);
  });

  it('records synchronous OCR success and failure', async () => {
    useOcrStore.setState({ candidates: [fileFixture({ id: 3, file_name: 'sync.pdf' })] });
    mocks.syncOcrParse.mockResolvedValueOnce('C:\\OCR\\sync.md');
    await expect(useOcrStore.getState().submitSyncParse(3)).resolves.toBe('C:\\OCR\\sync.md');
    expect(useOcrStore.getState().tasks[0]).toMatchObject({ status: 'completed', resultPath: 'C:\\OCR\\sync.md' });

    mocks.syncOcrParse.mockRejectedValueOnce(new Error('parse failed'));
    await expect(useOcrStore.getState().submitSyncParse(4)).rejects.toThrow('parse failed');
    expect(useOcrStore.getState().tasks.find((task) => task.fileId === 4)).toMatchObject({ status: 'failed' });
  });

  it('cancels an individual local task and ignores later progress events', async () => {
    mocks.cancelOcrTask.mockResolvedValue(true);
    useOcrStore.setState({
      tasks: [{
        taskId: 'local-1',
        fileId: 1,
        fileName: 'one.pdf',
        status: 'running',
        queuedAhead: null,
        progress: 10,
        submittedAt: 1,
        engine: 'windows',
      }],
    });
    await useOcrStore.getState().cancelTask('local-1');
    expect(mocks.cancelOcrTask).toHaveBeenCalledWith('local-1');
    expect(useOcrStore.getState().tasks[0].status).toBe('cancelled');

    useOcrStore.getState().updateWindowsProgress({
      task_id: 'local-1',
      file_id: 1,
      processed_pages: 5,
      total_pages: 10,
      progress: 50,
    });
    await vi.waitFor(() => expect(useOcrStore.getState().tasks[0].status).toBe('cancelled'));
    expect(useOcrStore.getState().tasks[0].progress).toBe(10);
  });

  it('persists OCR settings and refreshes engine health', async () => {
    mocks.setSetting.mockResolvedValue(undefined);
    mocks.getWindowsOcrStatus.mockResolvedValue({ available: true, languages: [], error: null });
    await useOcrStore.getState().saveApiUrl('http://ocr.local');
    await useOcrStore.getState().saveOutputDir('C:\\OCR');
    await useOcrStore.getState().saveWindowsLanguage('en-US');
    await useOcrStore.getState().saveRapidWorkerCount(99);
    await useOcrStore.getState().saveEngine('windows');

    expect(mocks.setSetting.mock.calls).toEqual([
      ['ocr_api_url', 'http://ocr.local'],
      ['ocr_output_dir', 'C:\\OCR'],
      ['windows_ocr_language', 'en-US'],
      ['rapidocr_worker_count', '8'],
      ['ocr_engine', 'windows'],
    ]);
    expect(useOcrStore.getState()).toMatchObject({
      apiUrl: 'http://ocr.local',
      outputDir: 'C:\\OCR',
      windowsLanguage: 'en-US',
      rapidWorkerCount: 8,
      engine: 'windows',
    });
  });
});
