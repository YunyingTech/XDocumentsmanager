import { useFolderStore } from '../../stores/folderStore';
import { FolderStatusBadge } from './FolderStatusBadge';
import { formatFileSize } from '../../lib/format';
import { HardDrive, Network, MoreVertical, RefreshCw, Trash2, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { removeFolder, startIndexing } from '../../lib/tauri';

interface FolderListProps {
  onAddFolder: () => void;
}

export function FolderList({ onAddFolder }: FolderListProps) {
  const folders = useFolderStore((s) => s.folders);
  const loadFolders = useFolderStore((s) => s.loadFolders);
  const [menuOpen, setMenuOpen] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);

  const handleRemove = async () => {
    if (deleteTarget !== null) {
      await removeFolder(deleteTarget);
      setDeleteTarget(null);
      loadFolders();
    }
  };

  const handleReindex = async (folderId: number) => {
    setMenuOpen(null);
    await startIndexing(folderId);
  };

  return (
    <div className="space-y-3">
      {folders.map((folder) => (
        <div
          key={folder.id}
          className="card flex items-center gap-4 p-4"
        >
          {/* Icon */}
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
            folder.folder_type === 'smb'
              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
              : 'bg-surface-100 dark:bg-surface-800 text-surface-500'
          }`}>
            {folder.folder_type === 'smb'
              ? <Network size={20} />
              : <HardDrive size={20} />
            }
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 truncate">
                {folder.display_name || folder.path.split('\\').pop() || folder.path}
              </h3>
              <FolderStatusBadge status={folder.last_scan_status} />
            </div>
            <p className="text-xs text-surface-400 mt-0.5 truncate">{folder.path}</p>
            <div className="flex items-center gap-4 mt-1.5 text-xs text-surface-500">
              <span>{folder.total_files.toLocaleString()} files</span>
              <span>{formatFileSize(folder.total_size_bytes)}</span>
              <span className="capitalize">{folder.folder_type} • {folder.watch_mode}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="relative">
            <button
              onClick={() => setMenuOpen(menuOpen === folder.id ? null : folder.id)}
              className="btn-ghost p-1.5 rounded-lg"
            >
              <MoreVertical size={16} />
            </button>

            {menuOpen === folder.id && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(null)} />
                <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 rounded-xl shadow-lg z-20 py-1">
                  <button
                    onClick={() => handleReindex(folder.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800"
                  >
                    <RefreshCw size={14} /> Re-index
                  </button>
                  {folder.is_active ? (
                    <button className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800">
                      <Pause size={14} /> Pause watching
                    </button>
                  ) : (
                    <button className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800">
                      <Play size={14} /> Resume watching
                    </button>
                  )}
                  <hr className="my-1 border-surface-200 dark:border-surface-800" />
                  <button
                    onClick={() => { setMenuOpen(null); setDeleteTarget(folder.id); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                  >
                    <Trash2 size={14} /> Remove
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ))}

      {deleteTarget !== null && (
        <ConfirmDialog
          open={true}
          title="Remove Folder"
          message="This will remove the folder from indexing and delete all associated file records. The actual PDF files on disk will not be affected."
          confirmLabel="Remove"
          onConfirm={handleRemove}
          onCancel={() => setDeleteTarget(null)}
          danger
        />
      )}
    </div>
  );
}
