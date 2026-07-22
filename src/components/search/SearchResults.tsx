import { useSearchStore } from '../../stores/searchStore';
import { useFileStore } from '../../stores/fileStore';
import { formatFileSize, formatDate } from '../../lib/format';
import { FileText, FolderOpen } from 'lucide-react';
import { showInFolder } from '../../lib/tauri';
import { useI18n } from '../../lib/i18n';

export function SearchResults() {
  const { locale, t } = useI18n();
  const results = useSearchStore((s) => s.results);
  const selectFile = useFileStore((s) => s.selectFile);

  return (
    <div className="p-4 space-y-2">
      {results.map((result) => (
        <div
          key={result.file.id}
          onClick={() => selectFile(result.file.id)}
          className="card p-4 cursor-pointer hover:border-accent-300 dark:hover:border-accent-600 transition-colors"
        >
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent-100 dark:bg-accent-900/30 flex items-center justify-center shrink-0 mt-0.5">
              <FileText size={14} className="text-accent-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-semibold text-surface-900 dark:text-surface-100 truncate">
                {result.file.file_name}
              </h4>
              <div className="flex items-center gap-2 mt-0.5">
                <p className="text-xs text-surface-400 truncate" title={result.absolute_path}>
                  {result.absolute_path}
                </p>
                <button
                  type="button"
                  className="btn-ghost p-1 rounded shrink-0"
                  title={t('search.openFolder')}
                  aria-label={t('search.openFolder')}
                  onClick={(event) => {
                    event.stopPropagation();
                    void showInFolder(result.absolute_path);
                  }}
                >
                  <FolderOpen size={13} />
                </button>
              </div>
              {/* Snippet */}
              {result.snippet && (
                <p className="text-sm text-surface-600 dark:text-surface-400 mt-2 line-clamp-2">
                  {result.snippet}
                </p>
              )}
              <div className="flex items-center gap-4 mt-2 text-xs text-surface-400">
                <span>{formatFileSize(result.file.file_size_bytes)}</span>
                <span>{result.file.page_count ? t('files.pageCount', { count: result.file.page_count }) : '-'}</span>
                <span>{formatDate(result.file.file_modified_at, locale)}</span>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
