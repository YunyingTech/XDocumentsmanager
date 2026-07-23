import { useSearchStore } from '../../stores/searchStore';
import { formatFileSize, formatDate } from '../../lib/format';
import { FileText, FolderOpen, Sparkles } from 'lucide-react';
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
        <article
          key={result.file.id}
          style={{ contentVisibility: 'auto', containIntrinsicSize: '0 160px' }}
          className={`card relative p-4 transition-colors hover:border-accent-300 focus-within:ring-2 focus-within:ring-accent-500 dark:hover:border-accent-600 ${
            selectedResultId === result.file.id
              ? 'border-accent-400 bg-accent-50/60 dark:border-accent-600 dark:bg-accent-950/20'
              : ''
          }`}
        >
          <button
            type="button"
            className="absolute inset-0 z-0 rounded-lg"
            aria-pressed={selectedResultId === result.file.id}
            aria-label={`${t('files.preview')}: ${result.file.file_name}`}
            onClick={() => selectResult(result.file.id)}
          />
          <div className="pointer-events-none relative z-10 flex items-start gap-3">
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
                  className="btn-ghost pointer-events-auto relative z-20 shrink-0 rounded p-1"
                  title={t('search.openFolder')}
                  aria-label={t('search.openFolder')}
                  onClick={() => {
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
              <div className="mt-2 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 text-xs text-surface-400">
                <div className="flex items-center gap-4">
                  <span>{formatFileSize(result.file.file_size_bytes)}</span>
                  <span>{result.file.page_count ? t('files.pageCount', { count: result.file.page_count }) : '-'}</span>
                  <span>{formatDate(result.file.file_modified_at, locale)}</span>
                </div>
                {result.matched_terms.length > 0 && (
                  <div
                    className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1"
                    title={t('search.aiMatchHint', {
                      model: result.match_model ?? t('common.unknown'),
                      terms: result.matched_terms.join(locale === 'zh-CN' ? '、' : ', '),
                    })}
                  >
                    <Sparkles size={12} className="mr-0.5 shrink-0 text-accent-500" />
                    <span className="mr-0.5 max-w-32 truncate font-mono text-[10px] text-accent-600 dark:text-accent-400">
                      {result.match_model ?? t('search.aiMatchedTerms')}
                    </span>
                    {result.matched_terms.slice(0, 3).map((term) => (
                      <span
                        key={term}
                        className="max-w-32 truncate rounded-sm border border-accent-200 bg-accent-50 px-1.5 py-0.5 text-[10px] text-accent-700 dark:border-accent-800 dark:bg-accent-950/40 dark:text-accent-300"
                      >
                        {term}
                      </span>
                    ))}
                    {result.matched_terms.length > 3 && (
                      <span className="text-[10px] tabular-nums text-surface-400">
                        +{result.matched_terms.length - 3}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
