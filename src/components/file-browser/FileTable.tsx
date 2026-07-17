import { useMemo, useCallback, useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useFileStore } from '../../stores/fileStore';
import { useFolderStore } from '../../stores/folderStore';
import { formatFileSize, formatDateTime } from '../../lib/format';
import { FileText, AlertCircle, Loader2, Eye } from 'lucide-react';
import type { FileInfo } from '../../types';
import { useUIStore } from '../../stores/uiStore';

const ROW_HEIGHT = 40;

export function FileTable() {
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
  const setView = useUIStore((s) => s.setView);

  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Load page when virtual scroll moves to a new page range
  useEffect(() => {
    const items = rowVirtualizer.getVirtualItems();
    if (items.length === 0) return;
    const firstIdx = items[0].index;
    const newPage = Math.floor(firstIdx / pageSize);
    if (newPage !== page) {
      setPage(newPage);
      if (selectedFolderId !== null) {
        loadFiles(selectedFolderId);
      }
    }
  }, [rowVirtualizer.getVirtualItems(), page, pageSize, selectedFolderId]);

  const handleSort = (field: string) => {
    if (sort.field === field) {
      setSort({ field: field as typeof sort.field, direction: sort.direction === 'asc' ? 'desc' : 'asc' });
    } else {
      setSort({ field: field as typeof sort.field, direction: 'asc' });
    }
    selectFile(null);
  };

  const SortIcon = ({ field }: { field: string }) => {
    if (sort.field !== field) return <span className="text-surface-300 dark:text-surface-600 ml-1">↕</span>;
    return <span className="text-accent-500 ml-1">{sort.direction === 'asc' ? '↑' : '↓'}</span>;
  };

  const statusIcon = (status: FileInfo['index_status']) => {
    switch (status) {
      case 'indexed': return <FileText size={14} className="text-green-500" />;
      case 'indexing': return <Loader2 size={14} className="text-accent-500 animate-spin" />;
      case 'error': return <AlertCircle size={14} className="text-red-500" />;
      case 'pending': return <FileText size={14} className="text-surface-300" />;
      case 'skipped': return <FileText size={14} className="text-surface-400" />;
    }
  };

  return (
    <div ref={parentRef} className="flex-1 overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center h-9 bg-surface-100 dark:bg-surface-900 border-b border-surface-200 dark:border-surface-800 text-xs font-semibold text-surface-500 uppercase tracking-wider">
        <div className="w-8 shrink-0" />
        <div
          className="flex-1 min-w-0 px-3 cursor-pointer hover:text-surface-700 dark:hover:text-surface-300"
          onClick={() => handleSort('file_name')}
        >
          Name <SortIcon field="file_name" />
        </div>
        <div
          className="w-28 shrink-0 px-2 cursor-pointer hover:text-surface-700 dark:hover:text-surface-300 hidden md:block"
          onClick={() => handleSort('file_size_bytes')}
        >
          Size <SortIcon field="file_size_bytes" />
        </div>
        <div
          className="w-44 shrink-0 px-2 cursor-pointer hover:text-surface-700 dark:hover:text-surface-300 hidden lg:block"
          onClick={() => handleSort('file_modified_at')}
        >
          Modified <SortIcon field="file_modified_at" />
        </div>
        <div className="w-20 shrink-0 px-2 hidden xl:block">
          Pages
        </div>
        <div className="w-24 shrink-0 px-2">
          Status
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
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const file = files[virtualRow.index % pageSize];
          if (!file) return null;

          const isSelected = selectedFileId === file.id;

          return (
            <div
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
              className={`flex items-center border-b border-surface-100 dark:border-surface-900 cursor-pointer transition-colors
                ${isSelected
                  ? 'bg-accent-50 dark:bg-accent-500/10 border-accent-100 dark:border-accent-500/20'
                  : 'hover:bg-surface-50 dark:hover:bg-surface-900'
                }`}
              onClick={() => selectFile(file.id)}
              onDoubleClick={() => setView('search')}
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
              <div className="w-28 shrink-0 px-2 text-sm text-surface-500 hidden md:block tabular-nums">
                {formatFileSize(file.file_size_bytes)}
              </div>
              <div className="w-44 shrink-0 px-2 text-sm text-surface-500 hidden lg:block">
                {formatDateTime(file.file_modified_at)}
              </div>
              <div className="w-20 shrink-0 px-2 text-sm text-surface-500 hidden xl:block tabular-nums">
                {file.page_count ?? '—'}
              </div>
              <div className="w-24 shrink-0 px-2">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium
                  ${file.index_status === 'indexed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                    file.index_status === 'indexing' ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/30 dark:text-accent-400' :
                    file.index_status === 'error' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                    'bg-surface-200 text-surface-500 dark:bg-surface-800'}
                `}>
                  {file.index_status}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
