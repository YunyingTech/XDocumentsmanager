import { useEffect } from 'react';
import {
  ScanText,
  CheckCircle,
  XCircle,
  Loader2,
  RefreshCw,
  Download,
  FolderOpen,
  Trash2,
  Wifi,
  WifiOff,
  FileText,
} from 'lucide-react';
import { useOcrStore } from '../../stores/ocrStore';
import { useFolderStore } from '../../stores/folderStore';
import { formatFileSize, formatDateTime } from '../../lib/format';

export function OcrPage() {
  const store = useOcrStore();
  const folders = useFolderStore((s) => s.folders);

  // Load settings and health on mount
  useEffect(() => {
    store.loadSettings().then(() => {
      store.checkHealth();
    });
    store.loadCandidates();
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
            OCR
          </h2>
          {/* Health indicator */}
          <HealthBadge />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { store.checkHealth(); store.loadCandidates(); }}
            className="btn-ghost p-1.5 rounded-lg"
            title="Refresh"
          >
            <RefreshCw size={16} className={store.healthChecking ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-5xl space-y-6">
          {/* ── Settings card ── */}
          <SettingsCard />

          {/* ── File selection ── */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                Select Files for OCR
              </h3>
              <div className="flex items-center gap-2">
                <button onClick={store.selectAll} className="btn-ghost text-xs px-2 py-1 rounded">
                  Select All
                </button>
                <button onClick={store.deselectAll} className="btn-ghost text-xs px-2 py-1 rounded">
                  Deselect All
                </button>
              </div>
            </div>

            {store.loadingCandidates ? (
              <div className="flex items-center justify-center py-8 text-surface-400">
                <Loader2 size={20} className="animate-spin mr-2" />
                Loading files...
              </div>
            ) : store.candidates.length === 0 ? (
              <div className="text-center py-8 text-surface-400">
                <FileText size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">No indexed PDF files available for OCR.</p>
                <p className="text-xs mt-1">Index some folders first, then return here.</p>
              </div>
            ) : (
              <FileTable />
            )}

            {/* Submit button */}
            {store.candidates.length > 0 && (
              <div className="mt-4 flex justify-end">
                <button
                  onClick={() => store.submitTasks()}
                  disabled={
                    store.selectedFileIds.size === 0 ||
                    !store.health?.connected
                  }
                  className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ScanText size={16} className="inline mr-1.5" />
                  Start OCR ({store.selectedFileIds.size} files)
                </button>
              </div>
            )}
          </div>

          {/* ── Task list ── */}
          {store.tasks.length > 0 && (
            <div className="card p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                  OCR Tasks
                </h3>
                <button
                  onClick={store.clearTasks}
                  className="btn-ghost text-xs px-2 py-1 rounded text-surface-400 hover:text-red-500"
                >
                  <Trash2 size={14} className="inline mr-1" />
                  Clear
                </button>
              </div>
              <TaskList />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──

function HealthBadge() {
  const health = useOcrStore((s) => s.health);
  const healthChecking = useOcrStore((s) => s.healthChecking);

  if (healthChecking) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-surface-400">
        <Loader2 size={12} className="animate-spin" />
        Checking...
      </span>
    );
  }
  if (!health) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-surface-400">
        <WifiOff size={12} />
        Not checked
      </span>
    );
  }
  if (health.connected) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
        <Wifi size={12} />
        Connected — {health.api_url}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-red-500">
      <WifiOff size={12} />
      Disconnected — {health.api_url}
    </span>
  );
}

function SettingsCard() {
  const apiUrl = useOcrStore((s) => s.apiUrl);
  const outputDir = useOcrStore((s) => s.outputDir);
  const saveApiUrl = useOcrStore((s) => s.saveApiUrl);
  const saveOutputDir = useOcrStore((s) => s.saveOutputDir);

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
        MinerU API Settings
      </h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-surface-500 mb-1">
            API URL
          </label>
          <input
            type="text"
            className="input text-sm"
            value={apiUrl}
            onChange={(e) => saveApiUrl(e.target.value)}
            placeholder="http://127.0.0.1:8000"
          />
        </div>
        <div>
          <label className="block text-xs text-surface-500 mb-1">
            Output Directory
          </label>
          <input
            type="text"
            className="input text-sm"
            value={outputDir}
            onChange={(e) => saveOutputDir(e.target.value)}
            placeholder="Default: {project}/OCR_result"
          />
        </div>
      </div>
    </div>
  );
}

function FileTable() {
  const candidates = useOcrStore((s) => s.candidates);
  const selectedFileIds = useOcrStore((s) => s.selectedFileIds);
  const toggleFile = useOcrStore((s) => s.toggleFile);
  const folders = useFolderStore((s) => s.folders);

  const getFolderPath = (folderId: number) => {
    const f = folders.find((f) => f.id === folderId);
    return f?.display_name || f?.path?.split('\\').pop() || `Folder #${folderId}`;
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-200 dark:border-surface-800">
            <th className="w-8 py-2 text-left">
              <span className="sr-only">Select</span>
            </th>
            <th className="py-2 text-left text-xs font-medium text-surface-500">File Name</th>
            <th className="py-2 text-left text-xs font-medium text-surface-500">Folder</th>
            <th className="py-2 text-right text-xs font-medium text-surface-500">Size</th>
            <th className="py-2 text-right text-xs font-medium text-surface-500">OCR Status</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((file) => {
            const isSelected = selectedFileIds.has(file.id);
            return (
              <tr
                key={file.id}
                onClick={() => toggleFile(file.id)}
                className={`border-b border-surface-100 dark:border-surface-900 cursor-pointer transition-colors hover:bg-surface-50 dark:hover:bg-surface-900 ${
                  isSelected ? 'bg-accent-50 dark:bg-accent-950/30' : ''
                }`}
              >
                <td className="py-2">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleFile(file.id)}
                    className="rounded"
                  />
                </td>
                <td className="py-2 text-surface-700 dark:text-surface-300 truncate max-w-64">
                  {file.file_name}
                </td>
                <td className="py-2 text-surface-500 text-xs">
                  {getFolderPath(file.folder_id)}
                </td>
                <td className="py-2 text-right text-surface-500 text-xs tabular-nums">
                  {formatFileSize(file.file_size_bytes)}
                </td>
                <td className="py-2 text-right">
                  {file.ocr_applied ? (
                    <span className="text-xs text-green-600 inline-flex items-center gap-1">
                      <CheckCircle size={12} /> Done
                    </span>
                  ) : (
                    <span className="text-xs text-surface-400">-</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TaskList() {
  const tasks = useOcrStore((s) => s.tasks);
  const downloadResult = useOcrStore((s) => s.downloadResult);

  return (
    <div className="space-y-2">
      {[...tasks].reverse().map((task, i) => (
        <div
          key={`${task.fileId}-${task.taskId}-${i}`}
          className="flex items-center gap-3 p-3 rounded-lg bg-surface-50 dark:bg-surface-900 border border-surface-200 dark:border-surface-800"
        >
          {/* Status icon */}
          <div className="shrink-0">
            {task.status === 'completed' ? (
              <CheckCircle size={18} className="text-green-500" />
            ) : task.status === 'failed' ? (
              <XCircle size={18} className="text-red-500" />
            ) : (
              <Loader2 size={18} className="text-accent-500 animate-spin" />
            )}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm text-surface-700 dark:text-surface-300 truncate">
                {task.fileName}
              </span>
              <StatusBadge status={task.status} />
              {task.queuedAhead != null && task.queuedAhead > 0 && (
                <span className="text-xs text-surface-400">
                  {task.queuedAhead} ahead
                </span>
              )}
            </div>
            {task.error && (
              <p className="text-xs text-red-500 mt-0.5 truncate">{task.error}</p>
            )}
            {task.resultPath && (
              <p className="text-xs text-green-600 mt-0.5 truncate">
                Saved: {task.resultPath}
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="shrink-0 flex items-center gap-1">
            {task.status === 'completed' && !task.resultPath && (
              <button
                onClick={() => downloadResult(task.taskId, task.fileId)}
                className="btn-ghost p-1.5 rounded-lg text-accent-500"
                title="Download result"
              >
                <Download size={14} />
              </button>
            )}
            {task.resultPath && (
              <button
                onClick={() => {
                  // Copy path to clipboard
                  navigator.clipboard.writeText(task.resultPath!);
                }}
                className="btn-ghost p-1.5 rounded-lg text-surface-400"
                title="Copy path"
              >
                <FolderOpen size={14} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    submitting: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    queued: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
    running: 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400',
    completed: 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400',
    failed: 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400',
  };

  return (
    <span className={`inline-flex text-xs px-1.5 py-0.5 rounded-full font-medium ${colors[status] || colors.submitting}`}>
      {status}
    </span>
  );
}
