import { useCallback, useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useFileStore } from '../../stores/fileStore';
import { useFolderStore } from '../../stores/folderStore';
import { formatFileSize, formatDateTime } from '../../lib/format';
import { FileText, AlertCircle, Loader2 } from 'lucide-react';
import type { FileInfo } from '../../types';
import { useI18n, type TranslationKey } from '../../lib/i18n';

const ROW_HEIGHT = 40;
const fileStatusKeys: Record<FileInfo['index_status'], TranslationKey> = {
  indexed: 'files.indexed',
  indexing: 'files.indexing',
  error: 'common.error',
  pending: 'files.pending',
  skipped: 'files.skipped',
};

export function FileTable({ compact = false }: { compact?: boolean }) {
  const { locale, t } = useI18n();
  const files = useFileStore((s) => s.files);
  const total = useFileStore((s) => s.total);
  const sort = useFileStore((s) => s.sort);
  const setSort = useFileStore((s) => s.setSort);
  const selectFile = useFileStore((s) => s.selectFile);
  const selectedFileId = useFileStore((s) => s.selectedFileId);
  const page = useFileStore((s) => s.page);
  const pageSize = useFileStore((s) => s.pageSize);
  const setPage = useFileStore((s) => s.setPage);
  const selectedFolderId = useFolderStore((s) => s.selectedFolderId);
  const loadFiles = useFileStore((s) => s.loadFiles);

  const parentRef = useRef<HTMLDivElement>(null);
  const isManualPageChange = useRef(false);

  const totalPages = Math.ceil(total / pageSize);

  const rowVirtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 });
  }, [sort.field, sort.direction]);

  // Load page when virtual scroll moves to a new page range
  useEffect(() => {
    if (isManualPageChange.current) return;
    if (virtualItems.length === 0) return;
    const firstIdx = virtualItems[0].index;
    const newPage = Math.floor(firstIdx / pageSize);
    if (newPage !== page) {
      selectFile(null);
      setPage(newPage);
      if (selectedFolderId !== null) {
        loadFiles(selectedFolderId);
      }
    }
  }, [virtualItems, page, pageSize, selectedFolderId, setPage, loadFiles, selectFile]);

  const handlePageJump = useCallback((newPage: number) => {
    if (newPage < 0 || newPage >= totalPages) return;
    isManualPageChange.current = true;
    selectFile(null);
    setPage(newPage);
    if (selectedFolderId !== null) {
      loadFiles(selectedFolderId);
    }
    rowVirtualizer.scrollToIndex(newPage * pageSize, { align: 'start' });
    requestAnimationFrame(() => {
      isManualPageChange.current = false;
    });
  }, [totalPages, pageSize, setPage, selectedFolderId, loadFiles, rowVirtualizer, selectFile]);

  const handleSort = (field: string) => {
    const nextSort = sort.field === field
      ? { field: field as typeof sort.field, direction: sort.direction === 'asc' ? 'desc' as const : 'asc' as const }
      : { field: field as typeof sort.field, direction: 'asc' as const };
    void setSort(nextSort, selectedFolderId);
    selectFile(null);
    rowVirtualizer.scrollToIndex(0, { align: 'start' });
  };

  const SortIcon = ({ field }: { field: string }) => {
    if (sort.field !== field) return <span aria-hidden="true" className="ml-1 text-surface-300 dark:text-surface-600">↕</span>;
    return <span aria-hidden="true" className="ml-1 text-accent-500">{sort.direction === 'asc' ? '↑' : '↓'}</span>;
  };

  const statusIcon = (status: FileInfo['index_status']) => {
    switch (status) {
      case 'indexed': return <FileText size={14} className="text-green-500" aria-hidden="true" />;
      case 'indexing': return <Loader2 size={14} className="text-accent-500 animate-spin" aria-hidden="true" />;
      case 'error': return <AlertCircle size={14} className="text-red-500" aria-hidden="true" />;
      case 'pending': return <FileText size={14} className="text-surface-300" aria-hidden="true" />;
      case 'skipped': return <FileText size={14} className="text-surface-400" aria-hidden="true" />;
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={parentRef} className="flex-1 overflow-auto">
        {/* Header */}
      <div className="sticky top-0 z-10 flex items-center h-9 bg-surface-100 dark:bg-surface-900 border-b border-surface-200 dark:border-surface-800 text-xs font-semibold text-surface-500 uppercase tracking-wider">
        <div className="w-8 shrink-0" />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center self-stretch px-3 text-left hover:text-surface-700 dark:hover:text-surface-300"
          onClick={() => handleSort('file_name')}
          aria-label={sort.field === 'file_name' ? `${t('files.name')}, ${sort.direction}` : t('files.name')}
        >
          {t('files.name')} <SortIcon field="file_name" />
        </button>
        <button
          type="button"
          className={`${compact ? 'hidden' : 'hidden md:flex'} w-28 shrink-0 items-center self-stretch px-2 text-left hover:text-surface-700 dark:hover:text-surface-300`}
          onClick={() => handleSort('file_size_bytes')}
          aria-label={sort.field === 'file_size_bytes' ? `${t('files.size')}, ${sort.direction}` : t('files.size')}
        >
          {t('files.size')} <SortIcon field="file_size_bytes" />
        </button>
        <button
          type="button"
          className={`${compact ? 'hidden' : 'hidden lg:flex'} w-44 shrink-0 items-center self-stretch px-2 text-left hover:text-surface-700 dark:hover:text-surface-300`}
          onClick={() => handleSort('file_modified_at')}
          aria-label={sort.field === 'file_modified_at' ? `${t('files.modified')}, ${sort.direction}` : t('files.modified')}
        >
          {t('files.modified')} <SortIcon field="file_modified_at" />
        </button>
        <div className={`${compact ? 'hidden' : 'hidden xl:block'} w-20 shrink-0 px-2`}>
          {t('files.pages')}
        </div>
        <div className="w-24 shrink-0 px-2">
          {t('files.status')}
        </div>
      </div>

      {/* Virtualized rows */}
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => {
          const file = files[virtualRow.index % pageSize];
          if (!file) return null;

          const isSelected = selectedFileId === file.id;

          return (
            <button
              type="button"
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className={`flex items-center border-b border-surface-100 text-left dark:border-surface-900 cursor-pointer transition-colors focus-visible:z-[1]
                ${isSelected
                  ? 'bg-accent-50 dark:bg-accent-500/10 border-accent-100 dark:border-accent-500/20'
                  : 'hover:bg-surface-50 dark:hover:bg-surface-900'
              }`}
              onClick={() => selectFile(file.id)}
              aria-pressed={isSelected}
              aria-label={`${file.file_name}, ${t(fileStatusKeys[file.index_status])}`}
            >
              <div className="w-8 shrink-0 flex justify-center">
                {statusIcon(file.index_status)}
              </div>
              <div className="flex-1 min-w-0 px-3 flex items-center gap-2">
                <span className="text-sm text-surface-800 dark:text-surface-200 truncate">
                  {file.file_name}
                </span>
                {file.pdf_title && file.pdf_title !== file.file_name && (
                  <span className="text-xs text-surface-400 truncate hidden sm:inline">
                    — {file.pdf_title}
                  </span>
                )}
              </div>
              <div className={`${compact ? 'hidden' : 'hidden md:block'} w-28 shrink-0 px-2 text-sm text-surface-500 tabular-nums`}>
                {formatFileSize(file.file_size_bytes)}
              </div>
              <div className={`${compact ? 'hidden' : 'hidden lg:block'} w-44 shrink-0 px-2 text-sm text-surface-500`}>
                {formatDateTime(file.file_modified_at, locale)}
              </div>
              <div className={`${compact ? 'hidden' : 'hidden xl:block'} w-20 shrink-0 px-2 text-sm text-surface-500 tabular-nums`}>
                {file.page_count ?? '—'}
              </div>
              <div className="w-24 shrink-0 px-2">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium
                  ${file.index_status === 'indexed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                    file.index_status === 'indexing' ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-400' :
                    file.index_status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                    'bg-surface-200 text-surface-500 dark:bg-surface-800'}
                `}>
                  {t(fileStatusKeys[file.index_status])}
                </span>
              </div>
            </button>
          );
        })}
        </div>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 bg-surface-100 dark:bg-surface-900 border-t border-surface-200 dark:border-surface-800 shrink-0">
          <span className="text-xs text-surface-500">
            {t('files.total', { count: total.toLocaleString(locale) })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handlePageJump(page - 1)}
              disabled={page <= 0}
              className="btn-ghost px-2 py-1 rounded text-xs disabled:opacity-30"
            >
              {t('common.previous')}
            </button>
            <span className="text-xs text-surface-600 dark:text-surface-400 tabular-nums">
              {t('files.pageOf', { page: page + 1, total: totalPages })}
            </span>
            <button
              type="button"
              onClick={() => handlePageJump(page + 1)}
              disabled={page >= totalPages - 1}
              className="btn-ghost px-2 py-1 rounded text-xs disabled:opacity-30"
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
