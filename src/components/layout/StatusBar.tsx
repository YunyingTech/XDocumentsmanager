import { useFolderStore } from '../../stores/folderStore';
import { useFileStore } from '../../stores/fileStore';
import { formatFileSize } from '../../lib/format';
import { FileText, Loader2, CheckCircle2, XCircle } from 'lucide-react';

export function StatusBar() {
  const indexProgress = useFolderStore((s) => s.indexProgress);
  const folders = useFolderStore((s) => s.folders);
  const fileCount = useFileStore((s) => s.total);

  // Use progress data when available, otherwise fall back to persisted folder totals
  const totalFiles = indexProgress && indexProgress.files_total > 0
    ? indexProgress.files_total
    : folders.reduce((sum, f) => sum + f.total_files, 0);
  const totalSize = folders.reduce((sum, f) => sum + f.total_size_bytes, 0);

  const isRunning = indexProgress && indexProgress.status === 'running';
  const isCompleted = indexProgress && indexProgress.status === 'completed';
  const pct = indexProgress && indexProgress.files_total > 0
    ? Math.round((indexProgress.files_indexed / indexProgress.files_total) * 100)
    : 0;

  return (
    <footer className="h-8 flex items-center gap-4 px-4 border-t border-surface-200 bg-white dark:bg-surface-950 dark:border-surface-800 text-xs text-surface-500 select-none">
      {/* File count */}
      <span className="flex items-center gap-1.5">
        <FileText size={12} />
        {totalFiles.toLocaleString()} files indexed
        {totalSize > 0 && (
          <span className="text-surface-400">({formatFileSize(totalSize)} total)</span>
        )}
      </span>

      <div className="flex-1" />

      {/* Indexing progress bar */}
      {isRunning && (
        <div className="flex items-center gap-2 min-w-[300px]">
          <Loader2 size={12} className="animate-spin text-accent-500" />
          <span className="text-accent-600 dark:text-accent-400 whitespace-nowrap">
            {indexProgress!.files_indexed.toLocaleString()} / {indexProgress!.files_total.toLocaleString()} files
          </span>
          <div className="flex-1 h-1.5 bg-surface-200 dark:bg-surface-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-500 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-accent-500 font-medium tabular-nums w-8 text-right">{pct}%</span>
        </div>
      )}

      {/* Completed state */}
      {isCompleted && (
        <div className="flex items-center gap-2 min-w-[300px]">
          <CheckCircle2 size={12} className="text-green-500" />
          <span className="text-green-600 dark:text-green-400 whitespace-nowrap">
            {indexProgress!.files_indexed.toLocaleString()} files indexed
          </span>
          <div className="flex-1 h-1.5 bg-green-200 dark:bg-green-900 rounded-full overflow-hidden">
            <div className="h-full bg-green-500 rounded-full w-full" />
          </div>
          <span className="text-green-500 font-medium">Done</span>
        </div>
      )}

      {/* Folder scan status */}
      {folders.map((f) => f.last_scan_status === 'error' && (
        <span key={f.id} className="flex items-center gap-1 text-red-500">
          <XCircle size={12} />
          {f.display_name || f.path.split('\\').pop()} — scan error
        </span>
      )).slice(0, 1)}
    </footer>
  );
}
