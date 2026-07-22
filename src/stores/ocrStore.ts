import { create } from 'zustand';
import {
  checkOcrHealth,
  submitOcrTask,
  queryOcrTask,
  getOcrResult,
  syncOcrParse,
  getWindowsOcrStatus,
  runWindowsOcr,
  listOcrCandidates,
  getSetting,
  setSetting,
} from '../lib/tauri';
import type { FileInfo, MinerUHealthInfo, OcrEngine, OcrTaskStatus, PaginatedResult, WindowsOcrProgress, WindowsOcrStatus } from '../types';
import { translate } from '../lib/i18n';
import { useUIStore } from './uiStore';

// ── Types ──

export interface OcrTask {
  taskId: string;
  fileId: number;
  fileName: string;
  status: 'submitting' | 'queued' | 'running' | 'completed' | 'failed';
  queuedAhead: number | null;
  progress: number | null;
  error?: string;
  resultPath?: string;
  submittedAt: number;
  engine: OcrEngine;
}

interface OcrStore {
  // Health
  health: MinerUHealthInfo | null;
  windowsStatus: WindowsOcrStatus | null;
  healthChecking: boolean;

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
  polling: boolean;
  pollTimer: ReturnType<typeof setInterval> | null;

  // Settings
  apiUrl: string;
  outputDir: string;
  engine: OcrEngine;
  windowsLanguage: string;

  // Actions
  checkHealth: () => Promise<void>;
  loadCandidates: (folderId?: number) => Promise<void>;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  toggleFile: (fileId: number) => void;
  selectAll: () => void;
  deselectAll: () => void;
  submitTasks: () => Promise<void>;
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
  updateWindowsProgress: (progress: WindowsOcrProgress) => void;
  clearTasks: () => void;
}

export const useOcrStore = create<OcrStore>((set, get) => ({
  health: null,
  windowsStatus: null,
  healthChecking: false,
  candidates: [],
  loadingCandidates: false,
  page: 0,
  pageSize: 50,
  totalCandidates: 0,
  totalPages: 0,
  selectedFileIds: new Set<number>(),
  tasks: [],
  polling: false,
  pollTimer: null,
  apiUrl: 'http://127.0.0.1:8000',
  outputDir: '',
  engine: 'mineru',
  windowsLanguage: 'auto',

  // ── Health check ──
  checkHealth: async () => {
    set({ healthChecking: true });
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
    try {
      const result = await checkOcrHealth();
      set({ health: result, healthChecking: false });
    } catch (e) {
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
      const result: PaginatedResult<FileInfo> = await listOcrCandidates(folderId, page, pageSize);
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
    const { selectedFileIds, candidates, engine, windowsLanguage } = get();
    const fileIds = [...selectedFileIds];

    for (const fileId of fileIds) {
      const file = candidates.find((f) => f.id === fileId);
      const fileName = file?.file_name || `file_${fileId}`;

      // Mark as submitting
      const task: OcrTask = {
        taskId: engine === 'windows' ? crypto.randomUUID() : '',
        fileId,
        fileName,
        status: 'submitting',
        queuedAhead: null,
        progress: null,
        submittedAt: Date.now(),
        engine,
      };
      set((s) => ({ tasks: [...s.tasks, task] }));

      try {
        if (engine === 'windows') {
          const localTaskId = task.taskId;
          set((s) => ({
            tasks: s.tasks.map((item) =>
              item.taskId === localTaskId
                ? { ...item, status: 'running' as const, progress: 0 }
                : item
            ),
          }));
          const resultPath = await runWindowsOcr(fileId, localTaskId, windowsLanguage);
          set((s) => ({
            tasks: s.tasks.map((item) =>
              item.taskId === localTaskId
                ? { ...item, status: 'completed' as const, progress: 100, resultPath }
                : item
            ),
          }));
          continue;
        }
        const resp = await submitOcrTask(fileId, true);
        // Update task with real ID
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.fileId === fileId && t.status === 'submitting'
              ? { ...t, taskId: resp.task_id, status: 'queued' as const }
              : t
          ),
        }));
      } catch (e: any) {
        set((s) => ({
          tasks: s.tasks.map((t) =>
            (engine === 'windows' ? t.taskId === task.taskId : t.fileId === fileId && t.status === 'submitting')
              ? { ...t, status: 'failed' as const, error: String(e) }
              : t
          ),
        }));
      }
    }

    // Start polling after submissions
    const { polling } = get();
    if (engine === 'mineru' && !polling) {
      get().startPolling();
    } else if (engine === 'windows') {
      set({ selectedFileIds: new Set() });
      await get().loadCandidates();
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
      const [apiUrl, outputDir, engine, windowsLanguage] = await Promise.all([
        getSetting('ocr_api_url'),
        getSetting('ocr_output_dir'),
        getSetting('ocr_engine'),
        getSetting('windows_ocr_language'),
      ]);
      set({
        apiUrl: apiUrl || 'http://127.0.0.1:8000',
        outputDir: outputDir || '',
        engine: engine === 'windows' ? 'windows' : 'mineru',
        windowsLanguage: windowsLanguage || 'auto',
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
    set({ engine, health: null, windowsStatus: null });
    await get().checkHealth();
  },

  saveWindowsLanguage: async (windowsLanguage: string) => {
    await setSetting('windows_ocr_language', windowsLanguage);
    set({ windowsLanguage });
  },

  updateWindowsProgress: (progress: WindowsOcrProgress) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.taskId === progress.task_id && task.engine === 'windows'
          ? { ...task, status: 'running' as const, progress: progress.progress }
          : task
      ),
    }));
  },

  clearTasks: () => {
    get().stopPolling();
    set({ tasks: [] });
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
