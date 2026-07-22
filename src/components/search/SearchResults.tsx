import { useSearchStore } from '../../stores/searchStore';
import { formatFileSize, formatDate } from '../../lib/format';
import { FileText, FolderOpen } from 'lucide-react';
import { showInFolder } from '../../lib/tauri';
import { useI18n } from '../../lib/i18n';

export function SearchResults() {
  const { locale, t } = useI18n();
  const results = useSearchStore((s) => s.results);
  const selectedResultId = useSearchStore((s) => s.selectedResultId);
  const selectResult = useSearchStore((s) => s.selectResult);

  return (
    <div className="p-4 space-y-2">
      {results.map((result) => (
        <div
          key={result.file.id}
          role="button"
          tabIndex={0}
          aria-pressed={selectedResultId === result.file.id}
          onClick={() => selectResult(result.file.id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              selectResult(result.file.id);
            }
          }}
          className={`card cursor-pointer p-4 transition-colors hover:border-accent-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:hover:border-accent-600 ${
            selectedResultId === result.file.id
              ? 'border-accent-400 bg-accent-50/60 dark:border-accent-600 dark:bg-accent-950/20'
              : ''
          }`}
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
