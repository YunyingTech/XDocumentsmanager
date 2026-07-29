import { create } from 'zustand';
import {
  checkOcrHealth,
  submitOcrTask,
  queryOcrTask,
  getOcrResult,
  syncOcrParse,
  getWindowsOcrStatus,
  runWindowsOcr,
  getPaddleOcrStatus,
  installPaddleOcr,
  runPaddleOcr,
  getRapidOcrStatus,
  installRapidOcr,
  runRapidOcr,
  cancelOcrTask,
  cancelAllOcrTasks,
  listOcrCandidates,
  listOcrCandidateRefs,
  getSetting,
  setSetting,
} from '../lib/tauri';
import type { FileInfo, MinerUHealthInfo, OcrCandidateRef, OcrEngine, OcrTaskStatus, PaddleDeviceMode, PaddleInstallProgress, PaddleOcrStatus, PaddlePackageIndex, PaginatedResult, RapidDeviceMode, RapidInstallProgress, RapidOcrStatus, WindowsOcrProgress, WindowsOcrStatus } from '../types';
import { translate } from '../lib/i18n';
import { useUIStore } from './uiStore';

// ── Types ──

export interface OcrTask {
  taskId: string;
  fileId: number;
  fileName: string;
  status: 'submitting' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  queuedAhead: number | null;
  progress: number | null;
  error?: string;
  resultPath?: string;
  submittedAt: number;
  engine: OcrEngine;
}

const WINDOWS_OCR_CONCURRENCY = 2;
const INCREMENTAL_OCR_BATCH_SIZE = 100;
const OCR_TASK_HISTORY_LIMIT = 2_000;
const pendingWindowsProgress = new Map<string, WindowsOcrProgress>();
const activeBulkOcr = new Map<string, string>();
const cancelledBulkOcr = new Set<string>();
let windowsProgressFrame: number | null = null;

interface OcrStore {
  // Health
  health: MinerUHealthInfo | null;
  windowsStatus: WindowsOcrStatus | null;
  paddleStatus: PaddleOcrStatus | null;
  rapidStatus: RapidOcrStatus | null;
  healthChecking: boolean;
  paddleInstallProgress: PaddleInstallProgress | null;
  isInstallingPaddle: boolean;
  rapidInstallProgress: RapidInstallProgress | null;
  isInstallingRapid: boolean;

  // Files
  candidates: FileInfo[];
  loadingCandidates: boolean;

  // Pagination
  page: number;
  pageSize: number;
  totalCandidates: number;
  totalPages: number;

  // Selection
  selectedFileIds: Set<number>;

  // Tasks
  tasks: OcrTask[];
  isSubmitting: boolean;
  bulkOcrRunning: boolean;
  bulkOcrQueued: number;
  polling: boolean;
  pollTimer: ReturnType<typeof setInterval> | null;

  // Settings
  apiUrl: string;
  outputDir: string;
  engine: OcrEngine;
  windowsLanguage: string;
  paddleLanguage: string;
  paddleModel: string;
  paddleDeviceMode: PaddleDeviceMode;
  paddlePypiPrimary: PaddlePackageIndex;
  paddlePypiFallback: PaddlePackageIndex;
  rapidLanguage: string;
  rapidModel: string;
  rapidDeviceMode: RapidDeviceMode;
  rapidPypiPrimary: PaddlePackageIndex;
  rapidPypiFallback: PaddlePackageIndex;

  // Actions
  checkHealth: () => Promise<void>;
  loadCandidates: (folderId?: number) => Promise<void>;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  toggleFile: (fileId: number) => void;
  selectAll: () => void;
  deselectAll: () => void;
  submitTasks: () => Promise<void>;
  submitFileBatch: (files: OcrCandidateRef[]) => Promise<void>;
  queueAllOcr: () => Promise<number>;
  queueFolderOcr: (folderId: number) => Promise<number>;
  queuePendingOcr: (folderId?: number) => Promise<number>;
  submitSyncParse: (fileId: number) => Promise<string>;
  pollAllTasks: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  downloadResult: (taskId: string, fileId: number) => Promise<void>;
  loadSettings: () => Promise<void>;
  saveApiUrl: (url: string) => Promise<void>;
  saveOutputDir: (dir: string) => Promise<void>;
  saveEngine: (engine: OcrEngine) => Promise<void>;
  saveWindowsLanguage: (language: string) => Promise<void>;
  savePaddleLanguage: (language: string) => Promise<void>;
  savePaddleModel: (model: string) => Promise<void>;
  savePaddleDeviceMode: (mode: PaddleDeviceMode) => Promise<void>;
  savePaddlePypiPrimary: (index: PaddlePackageIndex) => Promise<void>;
  savePaddlePypiFallback: (index: PaddlePackageIndex) => Promise<void>;
  installPaddle: () => Promise<void>;
  saveRapidLanguage: (language: string) => Promise<void>;
  saveRapidDeviceMode: (mode: RapidDeviceMode) => Promise<void>;
  saveRapidPypiPrimary: (index: PaddlePackageIndex) => Promise<void>;
  saveRapidPypiFallback: (index: PaddlePackageIndex) => Promise<void>;
  installRapid: () => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
  cancelAllTasks: () => Promise<void>;
  updateWindowsProgress: (progress: WindowsOcrProgress) => void;
  updatePaddleInstallProgress: (progress: PaddleInstallProgress) => void;
  updateRapidInstallProgress: (progress: RapidInstallProgress) => void;
  clearTasks: () => void;
}

export const useOcrStore = create<OcrStore>((set, get) => ({
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
  selectedFileIds: new Set<number>(),
  tasks: [],
  isSubmitting: false,
  bulkOcrRunning: false,
  bulkOcrQueued: 0,
  polling: false,
  pollTimer: null,
  apiUrl: 'http://127.0.0.1:8000',
  outputDir: '',
  engine: 'rapid',
  windowsLanguage: 'auto',
  paddleLanguage: 'ch',
  paddleModel: 'PP-OCRv5_mobile',
  paddleDeviceMode: 'auto',
  paddlePypiPrimary: 'ustc',
  paddlePypiFallback: 'tsinghua',
  rapidLanguage: 'ch',
  rapidModel: 'PP-OCRv6_small',
  rapidDeviceMode: 'auto',
  rapidPypiPrimary: 'ustc',
  rapidPypiFallback: 'tsinghua',

  // ── Health check ──
  checkHealth: async () => {
    set({ healthChecking: true });
    if (get().engine === 'rapid') {
      try {
        const rapidStatus = await getRapidOcrStatus();
        set({ rapidStatus, healthChecking: false });
      } catch (error) {
        set({ rapidStatus: failedRapidStatus(error), healthChecking: false });
      }
      return;
    }
    if (get().engine === 'windows') {
      try {
        const windowsStatus = await getWindowsOcrStatus();
        set({ windowsStatus, healthChecking: false });
      } catch (error) {
        set({
          windowsStatus: { available: false, languages: [], error: String(error) },
          healthChecking: false,
        });
      }
      return;
    }
    if (get().engine === 'paddle') {
      try {
        const paddleStatus = await getPaddleOcrStatus();
        set({ paddleStatus, healthChecking: false });
      } catch (error) {
        set({
          paddleStatus: failedPaddleStatus(error),
          healthChecking: false,
        });
      }
      return;
    }
    try {
      const result = await checkOcrHealth();
      set({ health: result, healthChecking: false });
    } catch {
      set({
        health: {
          protocol_version: '',
          processing_window_size: 0,
          max_concurrent_requests: 0,
          connected: false,
          api_url: get().apiUrl,
        },
        healthChecking: false,
      });
    }
  },

  // ── Load OCR candidates (indexed PDFs) ──
  loadCandidates: async (folderId?: number) => {
    set({ loadingCandidates: true });
    try {
      const { page, pageSize } = get();
      const result: PaginatedResult<FileInfo> = await listOcrCandidates(folderId, page, pageSize, true);
      set({
        candidates: result.items,
        totalCandidates: result.total,
        totalPages: result.total_pages,
        loadingCandidates: false,
      });
    } catch {
      set({ loadingCandidates: false });
    }
  },

  // ── Pagination ──
  setPage: (page: number) => set({ page }),
  setPageSize: (pageSize: number) => set({ pageSize, page: 0 }),

  // ── Selection ──
  toggleFile: (fileId: number) => {
    const selected = new Set(get().selectedFileIds);
    if (selected.has(fileId)) {
      selected.delete(fileId);
    } else {
      selected.add(fileId);
    }
    set({ selectedFileIds: selected });
  },

  selectAll: () => {
    const ids = new Set(get().candidates.map((f) => f.id));
    set({ selectedFileIds: ids });
  },

  deselectAll: () => {
    set({ selectedFileIds: new Set() });
  },

  // ── Submit async tasks ──
  submitTasks: async () => {
    if (get().isSubmitting) return;
    const { selectedFileIds, candidates } = get();
    const fileIds = [...selectedFileIds];
    if (fileIds.length === 0) return;
    const files = fileIds.map((fileId) => ({
      id: fileId,
      file_name: candidates.find((file) => file.id === fileId)?.file_name || `file_${fileId}`,
    }));
    set({ selectedFileIds: new Set() });
    await get().submitFileBatch(files);
  },

  submitFileBatch: async (files) => {
    if (get().isSubmitting || files.length === 0) return;
    const { engine, windowsLanguage, paddleLanguage, paddleModel, rapidLanguage, rapidModel } = get();
    const submittedAt = Date.now();
    const batch = files.map((file, index): OcrTask => ({
      taskId: crypto.randomUUID(),
      fileId: file.id,
      fileName: file.file_name,
      status: engine === 'mineru' ? 'submitting' : 'queued',
      queuedAhead: engine === 'mineru' ? null : index,
      progress: engine === 'mineru' ? null : 0,
      submittedAt: submittedAt + index,
      engine,
    }));
    const batchTaskIds = new Set(batch.map((task) => task.taskId));
    set((state) => ({
      tasks: [...state.tasks, ...batch],
      isSubmitting: true,
    }));

    if (engine === 'rapid' || engine === 'windows' || engine === 'paddle') {
      let nextIndex = 0;
      const runWorker = async () => {
        while (nextIndex < batch.length) {
          const task = batch[nextIndex++];
          if (get().tasks.find((item) => item.taskId === task.taskId)?.status === 'cancelled') {
            continue;
          }
          set((state) => ({
            tasks: state.tasks.map((item) =>
              item.taskId === task.taskId
                ? { ...item, status: 'running' as const, queuedAhead: null, progress: 0 }
                : batchTaskIds.has(item.taskId) && item.status === 'queued' && item.queuedAhead !== null
                  ? { ...item, queuedAhead: Math.max(0, item.queuedAhead - 1) }
                  : item
            ),
          }));
          try {
            const resultPath = engine === 'rapid'
              ? await runRapidOcr(task.fileId, task.taskId, rapidLanguage, rapidModel)
              : engine === 'windows'
                ? await runWindowsOcr(task.fileId, task.taskId, windowsLanguage)
                : await runPaddleOcr(task.fileId, task.taskId, paddleLanguage, paddleModel);
            set((state) => ({
              tasks: state.tasks.map((item) =>
                item.taskId === task.taskId
                  ? item.status === 'cancelled'
                    ? item
                    : { ...item, status: 'completed' as const, progress: 100, resultPath }
                  : item
              ),
            }));
          } catch (error) {
            set((state) => ({
              tasks: state.tasks.map((item) =>
                item.taskId === task.taskId
                  ? item.status === 'cancelled'
                    ? item
                    : { ...item, status: 'failed' as const, error: String(error) }
                  : item
              ),
            }));
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(engine === 'paddle' || engine === 'rapid' ? 1 : WINDOWS_OCR_CONCURRENCY, batch.length) }, () => runWorker())
      );
      await get().loadCandidates();
      set({ isSubmitting: false });
      return;
    }

    for (const task of batch) {
      if (get().tasks.find((item) => item.taskId === task.taskId)?.status === 'cancelled') {
        continue;
      }
      try {
        const resp = await submitOcrTask(task.fileId, true);
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.taskId === task.taskId && t.status !== 'cancelled'
              ? { ...t, taskId: resp.task_id, status: 'queued' as const }
              : t
          ),
        }));
      } catch (error) {
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.taskId === task.taskId && t.status !== 'cancelled'
              ? { ...t, status: 'failed' as const, error: String(error) }
              : t
          ),
        }));
      }
    }

    // Start polling after submissions
    const { polling, tasks } = get();
    const hasActiveMineruTasks = tasks.some(
      (task) => task.engine === 'mineru' && (task.status === 'queued' || task.status === 'running')
    );
    if (hasActiveMineruTasks && !polling) {
      get().startPolling();
    }
    set({ isSubmitting: false });
  },

  queueAllOcr: async () => get().queuePendingOcr(),

  queueFolderOcr: async (folderId) => get().queuePendingOcr(folderId),

  queuePendingOcr: async (folderId) => {
    const scope = folderId === undefined ? 'all' : `folder:${folderId}`;
    if (
      activeBulkOcr.has('all') ||
      activeBulkOcr.has(scope) ||
      (scope === 'all' && activeBulkOcr.size > 0)
    ) {
      return 0;
    }
    const runId = crypto.randomUUID();
    const startsNewQueue = activeBulkOcr.size === 0;
    activeBulkOcr.set(scope, runId);
    let plannedTotal = 0;
    set((state) => ({
      bulkOcrRunning: true,
      bulkOcrQueued: startsNewQueue ? 0 : state.bulkOcrQueued,
    }));
    try {
      plannedTotal = (await listOcrCandidates(folderId, 0, 1, true)).total;
      set((state) => ({
        bulkOcrQueued: startsNewQueue ? plannedTotal : state.bulkOcrQueued + plannedTotal,
      }));
      await get().loadSettings();
      let afterId = 0;
      let queued = 0;
      while (!cancelledBulkOcr.has(runId)) {
        const files = await listOcrCandidateRefs(folderId, afterId, INCREMENTAL_OCR_BATCH_SIZE);
        if (files.length === 0) break;
        while (get().isSubmitting && !cancelledBulkOcr.has(runId)) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
        if (cancelledBulkOcr.has(runId)) break;
        const submission = get().submitFileBatch(files);
        queued += files.length;
        if (plannedTotal === 0) {
          set((state) => ({ bulkOcrQueued: state.bulkOcrQueued + files.length }));
        }
        afterId = files[files.length - 1].id;
        await submission;

        if (get().engine === 'mineru' && !cancelledBulkOcr.has(runId)) {
          const batchIds = new Set(files.map((file) => file.id));
          while (get().tasks.some(
            (task) => batchIds.has(task.fileId) && ['submitting', 'queued', 'running'].includes(task.status)
          ) && !cancelledBulkOcr.has(runId)) {
            await get().pollAllTasks();
            await new Promise((resolve) => window.setTimeout(resolve, 1_000));
          }
        }

        set((state) => {
          if (state.tasks.length <= OCR_TASK_HISTORY_LIMIT) return state;
          const active = state.tasks.filter((task) => ['submitting', 'queued', 'running'].includes(task.status));
          const historyCapacity = Math.max(0, OCR_TASK_HISTORY_LIMIT - active.length);
          const terminal = state.tasks.filter(
            (task) => !['submitting', 'queued', 'running'].includes(task.status)
          );
          const history = historyCapacity > 0 ? terminal.slice(-historyCapacity) : [];
          return { tasks: [...history, ...active] };
        });
      }
      return queued;
    } finally {
      activeBulkOcr.delete(scope);
      cancelledBulkOcr.delete(runId);
      set({ bulkOcrRunning: activeBulkOcr.size > 0 });
    }
  },

  // ── Synchronous parse for single file ──
  submitSyncParse: async (fileId: number): Promise<string> => {
    const { candidates } = get();
    const file = candidates.find((f) => f.id === fileId);
    const fileName = file?.file_name || `file_${fileId}`;

    const task: OcrTask = {
      taskId: 'sync',
      fileId,
      fileName,
      status: 'running',
      queuedAhead: null,
      progress: null,
      submittedAt: Date.now(),
      engine: 'mineru',
    };
    set((s) => ({ tasks: [...s.tasks, task] }));

    try {
      const resultPath = await syncOcrParse(fileId, true, false);
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.fileId === fileId && t.taskId === 'sync'
            ? { ...t, status: 'completed' as const, resultPath }
            : t
        ),
      }));
      return resultPath;
    } catch (e: any) {
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.fileId === fileId && t.taskId === 'sync'
            ? { ...t, status: 'failed' as const, error: String(e) }
            : t
        ),
      }));
      throw e;
    }
  },

  // ── Poll all active tasks ──
  pollAllTasks: async () => {
    const { tasks } = get();
    const activeTasks = tasks.filter(
      (t) => t.engine === 'mineru' && (t.status === 'queued' || t.status === 'running')
    );

    for (const task of activeTasks) {
      if (!task.taskId) continue;
      try {
        const status: OcrTaskStatus = await queryOcrTask(task.taskId);
        const newStatus = mapApiStatus(status.status);

        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.taskId === task.taskId
              ? {
                  ...t,
                  status: newStatus,
                  queuedAhead: status.queued_ahead ?? null,
                  progress: status.progress ?? null,
                  error: status.error_message ?? t.error,
                }
              : t
          ),
        }));

        // Auto-download on completion
        if (newStatus === 'completed') {
          try {
            const resultPath = await getOcrResult(task.taskId, task.fileId);
            set((s) => ({
              tasks: s.tasks.map((t) =>
                t.taskId === task.taskId ? { ...t, resultPath } : t
              ),
            }));
          } catch (e: any) {
            set((s) => ({
              tasks: s.tasks.map((t) =>
                t.taskId === task.taskId
                  ? { ...t, status: 'failed' as const, error: translate(useUIStore.getState().language, 'tasks.resultDownloadFailed', { error: String(e) }) }
                  : t
              ),
            }));
          }
        }
      } catch (e: any) {
        // Don't mark as failed on transient polling errors
        console.warn(`Poll failed for task ${task.taskId}:`, e);
      }
    }

    // Refresh candidates after changes
    const stillActive = get().tasks.filter(
      (t) => t.status === 'queued' || t.status === 'running' || t.status === 'submitting'
    );
    if (stillActive.length === 0 && get().polling) {
      get().stopPolling();
      get().loadCandidates();
    }
  },

  // ── Polling control ──
  startPolling: () => {
    const timer = setInterval(() => {
      get().pollAllTasks();
    }, 3000); // poll every 3 seconds
    set({ polling: true, pollTimer: timer });
  },

  stopPolling: () => {
    const { pollTimer } = get();
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    set({ polling: false, pollTimer: null });
  },

  // ── Download result manually ──
  downloadResult: async (taskId: string, fileId: number) => {
    try {
      const resultPath = await getOcrResult(taskId, fileId);
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.taskId === taskId ? { ...t, resultPath, status: 'completed' as const } : t
        ),
      }));
    } catch (e: any) {
      set((s) => ({
        tasks: s.tasks.map((t) =>
          t.taskId === taskId
            ? { ...t, error: translate(useUIStore.getState().language, 'tasks.downloadFailed', { error: String(e) }) }
            : t
        ),
      }));
    }
  },

  // ── Settings ──
  loadSettings: async () => {
    try {
      const [apiUrl, outputDir, engine, windowsLanguage, paddleLanguage, paddleModel, paddleDeviceMode, paddlePypiPrimary, paddlePypiFallback, rapidLanguage, rapidModel, rapidDeviceMode, rapidPypiPrimary, rapidPypiFallback] = await Promise.all([
        getSetting('ocr_api_url'),
        getSetting('ocr_output_dir'),
        getSetting('ocr_engine'),
        getSetting('windows_ocr_language'),
        getSetting('paddle_ocr_language'),
        getSetting('paddle_ocr_model'),
        getSetting('paddle_device_mode'),
        getSetting('paddle_pypi_primary'),
        getSetting('paddle_pypi_fallback'),
        getSetting('rapidocr_language'),
        getSetting('rapidocr_model'),
        getSetting('rapidocr_device_mode'),
        getSetting('rapidocr_pypi_primary'),
        getSetting('rapidocr_pypi_fallback'),
      ]);
      set({
        apiUrl: apiUrl || 'http://127.0.0.1:8000',
        outputDir: outputDir || '',
        engine: engine === 'rapid' || engine === 'mineru' || engine === 'windows' || engine === 'paddle' ? engine : 'rapid',
        windowsLanguage: windowsLanguage || 'auto',
        paddleLanguage: paddleLanguage || 'ch',
        paddleModel: paddleModel || 'PP-OCRv5_mobile',
        paddleDeviceMode: deviceMode(paddleDeviceMode),
        paddlePypiPrimary: packageIndex(paddlePypiPrimary, 'ustc'),
        paddlePypiFallback: packageIndex(paddlePypiFallback, 'tsinghua'),
        rapidLanguage: rapidLanguage || 'ch',
        rapidModel: rapidModel || 'PP-OCRv6_small',
        rapidDeviceMode: rapidDeviceModeValue(rapidDeviceMode),
        rapidPypiPrimary: packageIndex(rapidPypiPrimary, 'ustc'),
        rapidPypiFallback: packageIndex(rapidPypiFallback, 'tsinghua'),
      });
    } catch {
      // use defaults
    }
  },

  saveApiUrl: async (url: string) => {
    await setSetting('ocr_api_url', url);
    set({ apiUrl: url });
  },

  saveOutputDir: async (dir: string) => {
    await setSetting('ocr_output_dir', dir);
    set({ outputDir: dir });
  },

  saveEngine: async (engine: OcrEngine) => {
    await setSetting('ocr_engine', engine);
    set({ engine, health: null, windowsStatus: null, paddleStatus: null, rapidStatus: null });
    await get().checkHealth();
  },

  saveWindowsLanguage: async (windowsLanguage: string) => {
    await setSetting('windows_ocr_language', windowsLanguage);
    set({ windowsLanguage });
  },

  savePaddleLanguage: async (paddleLanguage: string) => {
    await setSetting('paddle_ocr_language', paddleLanguage);
    set({ paddleLanguage });
  },

  savePaddleModel: async (paddleModel: string) => {
    await setSetting('paddle_ocr_model', paddleModel);
    set({ paddleModel });
  },

  savePaddleDeviceMode: async (paddleDeviceMode) => {
    await setSetting('paddle_device_mode', paddleDeviceMode);
    set({ paddleDeviceMode, paddleStatus: null });
    if (get().engine === 'paddle') {
      await get().checkHealth();
    }
  },

  savePaddlePypiPrimary: async (paddlePypiPrimary) => {
    await setSetting('paddle_pypi_primary', paddlePypiPrimary);
    set({ paddlePypiPrimary });
  },

  savePaddlePypiFallback: async (paddlePypiFallback) => {
    await setSetting('paddle_pypi_fallback', paddlePypiFallback);
    set({ paddlePypiFallback });
  },

  installPaddle: async () => {
    if (get().isInstallingPaddle) return;
    set({
      isInstallingPaddle: true,
      paddleInstallProgress: { stage: 'preparing', progress: 0, message: '' },
    });
    try {
      const { paddlePypiPrimary, paddlePypiFallback, paddleDeviceMode } = get();
      const paddleStatus = await installPaddleOcr(paddlePypiPrimary, paddlePypiFallback, paddleDeviceMode);
      set({ paddleStatus, isInstallingPaddle: false });
    } catch (error) {
      set({
        paddleStatus: failedPaddleStatus(error),
        paddleInstallProgress: { stage: 'failed', progress: 100, message: String(error) },
        isInstallingPaddle: false,
      });
    }
  },

  saveRapidLanguage: async (rapidLanguage: string) => {
    await setSetting('rapidocr_language', rapidLanguage);
    set({ rapidLanguage });
  },

  saveRapidDeviceMode: async (rapidDeviceMode) => {
    await setSetting('rapidocr_device_mode', rapidDeviceMode);
    set({ rapidDeviceMode, rapidStatus: null });
    if (get().engine === 'rapid') {
      await get().checkHealth();
    }
  },

  saveRapidPypiPrimary: async (rapidPypiPrimary) => {
    await setSetting('rapidocr_pypi_primary', rapidPypiPrimary);
    set({ rapidPypiPrimary });
  },

  saveRapidPypiFallback: async (rapidPypiFallback) => {
    await setSetting('rapidocr_pypi_fallback', rapidPypiFallback);
    set({ rapidPypiFallback });
  },

  installRapid: async () => {
    if (get().isInstallingRapid) return;
    set({
      isInstallingRapid: true,
      rapidInstallProgress: { stage: 'preparing', progress: 0, message: '' },
    });
    try {
      const rapidStatus = await installRapidOcr(get().rapidDeviceMode);
      set({ rapidStatus, isInstallingRapid: false });
    } catch (error) {
      set({
        rapidStatus: failedRapidStatus(error),
        rapidInstallProgress: { stage: 'failed', progress: 100, message: String(error) },
        isInstallingRapid: false,
      });
    }
  },

  cancelTask: async (taskId: string) => {
    const task = get().tasks.find((item) => item.taskId === taskId);
    if (!task || !['submitting', 'queued', 'running'].includes(task.status)) return;
    set((state) => ({
      tasks: state.tasks.map((item) =>
        item.taskId === taskId
          ? { ...item, status: 'cancelled' as const, queuedAhead: null, error: undefined }
          : item
      ),
    }));
    if (task.status === 'running' && task.engine !== 'mineru') {
      try {
        await cancelOcrTask(taskId);
      } catch (error) {
        console.error(`Failed to cancel OCR task ${taskId}:`, error);
      }
    }
  },

  cancelAllTasks: async () => {
    const activeTasks = get().tasks.filter((task) =>
      ['submitting', 'queued', 'running'].includes(task.status)
    );
    const bulkRuns = [...activeBulkOcr.values()];
    if (activeTasks.length === 0 && bulkRuns.length === 0) return;
    bulkRuns.forEach((runId) => cancelledBulkOcr.add(runId));
    set((state) => ({
      tasks: state.tasks.map((task) =>
        ['submitting', 'queued', 'running'].includes(task.status)
          ? { ...task, status: 'cancelled' as const, queuedAhead: null, error: undefined }
          : task
      ),
    }));
    get().stopPolling();
    pendingWindowsProgress.clear();
    try {
      await cancelAllOcrTasks();
    } catch (error) {
      console.error('Failed to cancel all OCR tasks:', error);
    }
  },

  updateWindowsProgress: (progress: WindowsOcrProgress) => {
    pendingWindowsProgress.set(progress.task_id, progress);
    if (windowsProgressFrame !== null) return;
    windowsProgressFrame = window.requestAnimationFrame(() => {
      const updates = new Map(pendingWindowsProgress);
      pendingWindowsProgress.clear();
      windowsProgressFrame = null;
      set((state) => ({
        tasks: state.tasks.map((task) => {
          const update = updates.get(task.taskId);
          return update && (task.engine === 'rapid' || task.engine === 'windows' || task.engine === 'paddle') && task.status !== 'cancelled'
            ? { ...task, status: 'running' as const, progress: update.progress }
            : task;
        }),
      }));
    });
  },

  updatePaddleInstallProgress: (progress: PaddleInstallProgress) => {
    set({
      paddleInstallProgress: progress,
      isInstallingPaddle: progress.stage !== 'completed' && progress.stage !== 'failed',
    });
  },

  updateRapidInstallProgress: (progress: RapidInstallProgress) => {
    set({
      rapidInstallProgress: progress,
      isInstallingRapid: progress.stage !== 'completed' && progress.stage !== 'failed',
    });
  },

  clearTasks: () => {
    if (activeBulkOcr.size > 0) return;
    get().stopPolling();
    pendingWindowsProgress.clear();
    if (windowsProgressFrame !== null) {
      window.cancelAnimationFrame(windowsProgressFrame);
      windowsProgressFrame = null;
    }
    set({ tasks: [], isSubmitting: false, bulkOcrQueued: 0 });
  },
}));

// ── Helper ──

function mapApiStatus(apiStatus: string): OcrTask['status'] {
  switch (apiStatus) {
    case 'pending':
    case 'queued':
      return 'queued';
    case 'running':
    case 'processing':
      return 'running';
    case 'completed':
    case 'done':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'queued';
  }
}

function failedPaddleStatus(error: unknown): PaddleOcrStatus {
  return {
    available: false,
    python_path: '',
    managed: true,
    install_supported: true,
    install_required: true,
    runtime_version: null,
    paddle_version: null,
    paddleocr_version: null,
    requested_device_mode: 'auto',
    active_device: null,
    runtime_profile: null,
    gpu_detected: false,
    gpu_compatible: false,
    gpu_runtime_installed: false,
    gpu_name: null,
    gpu_compute_capability: null,
    gpu_driver_version: null,
    cuda_version: null,
    cudnn_version: null,
    fallback_reason: null,
    error: String(error),
  };
}

function failedRapidStatus(error: unknown): RapidOcrStatus {
  return {
    available: false,
    python_path: '',
    managed: true,
    install_supported: true,
    install_required: true,
    runtime_version: null,
    rapidocr_version: null,
    onnxruntime_version: null,
    pymupdf_version: null,
    requested_device_mode: 'auto',
    requested_provider: null,
    active_provider: null,
    accelerated: false,
    available_providers: [],
    session_providers: [],
    runtime_profile: null,
    fallback_reason: null,
    error: String(error),
  };
}

function packageIndex(value: string | null, fallback: PaddlePackageIndex): PaddlePackageIndex {
  return value === 'ustc' || value === 'tsinghua' || value === 'official' ? value : fallback;
}

function deviceMode(value: string | null): PaddleDeviceMode {
  return value === 'cpu' || value === 'cuda12' ? value : 'auto';
}

function rapidDeviceModeValue(value: string | null): RapidDeviceMode {
  return value === 'cpu' ? 'cpu' : 'auto';
}
