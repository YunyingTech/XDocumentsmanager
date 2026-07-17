import { useFolderStore } from '../../stores/folderStore';
import { useFileStore } from '../../stores/fileStore';
import { formatFileSize } from '../../lib/format';
import { FileText, Loader2 } from 'lucide-react';

export function StatusBar() {
  const indexProgress = useFolderStore((s) => s.indexProgress);
  const folders = useFolderStore((s) => s.folders);
  const fileCount = useFileStore((s) => s.total);

  const totalFiles = folders.reduce((sum, f) => sum + f.total_files, 0);
  const totalSize = folders.reduce((sum, f) => sum + f.total_size_bytes, 0);

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

      {/* Indexing progress */}
      {indexProgress && indexProgress.status === 'running' && (
        <span className="flex items-center gap-1.5 text-accent-500">
          <Loader2 size={12} className="animate-spin" />
          Indexing... {indexProgress.files_indexed.toLocaleString()} /{' '}
          {indexProgress.files_total.toLocaleString()} files
        </span>
      )}

      {/* Folder scan status */}
      {folders.map((f) => f.last_scan_status === 'error' && (
        <span key={f.id} className="text-red-500">
          ⚠ {f.display_name || f.path.split('\\').pop()} — scan error
        </span>
      )).slice(0, 1)}
    </footer>
  );
}
