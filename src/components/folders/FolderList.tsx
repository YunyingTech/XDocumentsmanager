import type { FolderInfo } from '../../types';
import { useFolderStore } from '../../stores/folderStore';
import { FolderStatusBadge } from './FolderStatusBadge';
import { formatFileSize } from '../../lib/format';
import { HardDrive, Network, MoreVertical, RefreshCw, RotateCcw, ScanText, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { removeFolder, startIndexing } from '../../lib/tauri';
import { useI18n } from '../../lib/i18n';

interface FolderListProps {
  onAddFolder: () => void;
}

export function FolderList({ onAddFolder: _onAddFolder }: FolderListProps) {
  const { locale, t } = useI18n();
  const folders = useFolderStore((s) => s.folders);
  const indexProgressByJob = useFolderStore((s) => s.indexProgressByJob);
  const liveStatuses: Record<number, FolderInfo['last_scan_status']> = {};
  // A restarted job takes precedence over the previous job's completion notice.
  for (const progress of Object.values(indexProgressByJob).sort((a, b) => a.job_id - b.job_id)) {
    if (progress.folder_id === null) continue;
    if (progress.status === 'queued' || progress.status === 'running') {
      liveStatuses[progress.folder_id] = 'running';
    } else if (progress.status === 'completed' || progress.status === 'error') {
      liveStatuses[progress.folder_id] = progress.status;
    }
  }
  const loadFolders = useFolderStore((s) => s.loadFolders);
  const [menuOpen, setMenuOpen] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [fullReindexTarget, setFullReindexTarget] = useState<number | null>(null);
  const folderTypeLabel = { local: t('folders.typeLocal'), smb: t('folders.typeSmb') };
  const watchModeLabel = { auto: t('folders.modeAuto'), polling: t('folders.modePolling'), manual: t('folders.modeManual') };

  useEffect(() => {
    if (menuOpen === null) return;
    const triggerId = `folder-actions-trigger-${menuOpen}`;
    const menu = document.getElementById(`folder-actions-${menuOpen}`);
    const items = Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    requestAnimationFrame(() => items[0]?.focus());

    const handleMenuKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(null);
        requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || items.length === 0) return;
      event.preventDefault();
      const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    };
    document.addEventListener('keydown', handleMenuKey);
    return () => document.removeEventListener('keydown', handleMenuKey);
  }, [menuOpen]);

  const handleRemove = async () => {
    if (deleteTarget !== null) {
      await removeFolder(deleteTarget);
      setDeleteTarget(null);
      loadFolders();
    }
  };

  const handleIncrementalIndex = async (folderId: number, ocrAfterIndex = false) => {
    setMenuOpen(null);
    await startIndexing(folderId, ocrAfterIndex);
  };

  const handleFullReindex = async () => {
    if (fullReindexTarget === null) return;
    const folderId = fullReindexTarget;
    setFullReindexTarget(null);
    await startIndexing(folderId, false, 'full');
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
              <FolderStatusBadge status={liveStatuses[folder.id] ?? folder.last_scan_status} />
            </div>
            <p className="text-xs text-surface-400 mt-0.5 truncate">{folder.path}</p>
            <div className="flex items-center gap-4 mt-1.5 text-xs text-surface-500">
              <span>{t('folders.fileCount', { count: folder.total_files.toLocaleString(locale) })}</span>
              <span>{formatFileSize(folder.total_size_bytes)}</span>
              <span>{t('folders.typeMode', { type: folderTypeLabel[folder.folder_type], mode: watchModeLabel[folder.watch_mode] })}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="relative">
            <button
              id={`folder-actions-trigger-${folder.id}`}
              type="button"
              onClick={() => setMenuOpen(menuOpen === folder.id ? null : folder.id)}
              className="btn-ghost p-1.5 rounded-lg"
              aria-label={`${t('folders.management')}: ${folder.display_name || folder.path}`}
              aria-expanded={menuOpen === folder.id}
              aria-controls={`folder-actions-${folder.id}`}
            >
              <MoreVertical size={16} aria-hidden="true" />
            </button>

            {menuOpen === folder.id && (
              <>
                <button type="button" className="fixed inset-0 z-10 cursor-default" onClick={() => setMenuOpen(null)} aria-label={t('common.close')} />
                <div id={`folder-actions-${folder.id}`} role="menu" className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-surface-200 bg-white py-1 shadow-lg dark:border-surface-800 dark:bg-surface-900">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => handleIncrementalIndex(folder.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800"
                  >
                    <RefreshCw size={14} /> {t('files.incrementalIndex')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => handleIncrementalIndex(folder.id, true)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800"
                  >
                    <ScanText size={14} /> {t('folders.indexAndOcr')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setMenuOpen(null); setFullReindexTarget(folder.id); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800"
                  >
                    <RotateCcw size={14} /> {t('files.fullReindex')}
                  </button>
                  <hr className="my-1 border-surface-200 dark:border-surface-800" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setMenuOpen(null); setDeleteTarget(folder.id); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                  >
                    <Trash2 size={14} /> {t('common.remove')}
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
          title={t('folders.removeTitle')}
          message={t('folders.removeMessage')}
          confirmLabel={t('common.remove')}
          onConfirm={handleRemove}
          onCancel={() => setDeleteTarget(null)}
          danger
        />
      )}
      <ConfirmDialog
        open={fullReindexTarget !== null}
        title={t('files.fullReindexTitle')}
        message={t('files.fullReindexMessage')}
        confirmLabel={t('files.fullReindex')}
        onConfirm={() => void handleFullReindex()}
        onCancel={() => setFullReindexTarget(null)}
      />
    </div>
  );
}
