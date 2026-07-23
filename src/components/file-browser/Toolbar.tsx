import { useFolderStore } from '../../stores/folderStore';
import { useFileStore } from '../../stores/fileStore';
import { useSearchStore } from '../../stores/searchStore';
import { useUIStore } from '../../stores/uiStore';
import { Search, RefreshCw, FolderOpen, ScanText } from 'lucide-react';
import { startIndexing } from '../../lib/tauri';
import { useI18n } from '../../lib/i18n';

export function Toolbar() {
  const { locale, t } = useI18n();
  const selectedFolderId = useFolderStore((s) => s.selectedFolderId);
  const folders = useFolderStore((s) => s.folders);
  const sort = useFileStore((s) => s.sort);
  const setSort = useFileStore((s) => s.setSort);
  const loadFiles = useFileStore((s) => s.loadFiles);
  const selectFile = useFileStore((s) => s.selectFile);
  const setView = useUIStore((s) => s.setView);
  const toggleSearch = useSearchStore((s) => s.toggleOpen);

  const selectedFolder = folders.find((f) => f.id === selectedFolderId);

  const handleRefresh = async () => {
    if (selectedFolderId !== null) {
      await loadFiles(selectedFolderId);
    }
  };

  const handleReindex = async () => {
    if (selectedFolderId !== null) {
      await startIndexing(selectedFolderId);
    }
  };

  const handleIndexAndOcr = async () => {
    if (selectedFolderId !== null) {
      await startIndexing(selectedFolderId, true);
    }
  };

  const handleSearch = () => {
    setView('search');
    toggleSearch();
  };

  return (
    <div className="flex items-center gap-3 px-4 h-12 border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950">
      {/* Folder name / breadcrumb */}
      <div className="flex items-center gap-2 text-sm font-medium text-surface-700 dark:text-surface-300 min-w-0">
        <FolderOpen size={16} className="shrink-0 text-surface-400" />
        <span className="truncate">
          {selectedFolder?.display_name || selectedFolder?.path?.split('\\').pop() || t('files.title')}
        </span>
        {selectedFolder && (
          <span className="text-surface-400 font-normal">
            {t('files.pdfCount', { count: selectedFolder.total_files.toLocaleString(locale) })}
          </span>
        )}
      </div>

      <div className="flex-1" />

      {/* Sort controls */}
      <select
        value={`${sort.field}:${sort.direction}`}
        onChange={(e) => {
          const [field, direction] = e.target.value.split(':') as [typeof sort.field, typeof sort.direction];
          void setSort({ field, direction }, selectedFolderId);
          selectFile(null);
        }}
        className="text-xs bg-surface-100 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg px-2.5 py-1.5 text-surface-600 dark:text-surface-400"
      >
        <option value="file_modified_at:desc">{t('files.sortNewest')}</option>
        <option value="file_modified_at:asc">{t('files.sortOldest')}</option>
        <option value="file_name:asc">{t('files.sortNameAsc')}</option>
        <option value="file_name:desc">{t('files.sortNameDesc')}</option>
        <option value="file_size_bytes:desc">{t('files.sortSizeDesc')}</option>
        <option value="file_size_bytes:asc">{t('files.sortSizeAsc')}</option>
      </select>

      {/* Actions */}
      <button onClick={handleRefresh} className="btn-ghost p-1.5 rounded-lg" title={t('common.refresh')} aria-label={t('common.refresh')}>
        <RefreshCw size={16} />
      </button>
      <button onClick={handleReindex} className="btn-secondary text-xs py-1.5" title={t('files.reindexFolder')}>
        {t('files.reindex')}
      </button>
      <button onClick={handleIndexAndOcr} className="btn-secondary flex items-center gap-1.5 py-1.5 text-xs" title={t('files.indexAndOcr')}>
        <ScanText size={14} />
        {t('files.indexAndOcr')}
      </button>
      <button onClick={handleSearch} className="btn-ghost p-1.5 rounded-lg" title={t('common.search')} aria-label={t('common.search')}>
        <Search size={16} />
      </button>
    </div>
  );
}
