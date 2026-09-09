import { useSearchStore } from '../../stores/searchStore';
import { formatFileSize, formatDate } from '../../lib/format';
import { ChevronLeft, ChevronRight, FileText, FolderOpen, Sparkles } from 'lucide-react';
import { showInFolder } from '../../lib/tauri';
import { useI18n } from '../../lib/i18n';

export function SearchResults() {
  const { locale, t } = useI18n();
  const results = useSearchStore((s) => s.results);
  const selectedResultId = useSearchStore((s) => s.selectedResultId);
  const selectResult = useSearchStore((s) => s.selectResult);
  const page = useSearchStore((s) => s.page);
  const pageSize = useSearchStore((s) => s.pageSize);
  const total = useSearchStore((s) => s.total);
  const totalPages = useSearchStore((s) => s.totalPages);
  const isSearching = useSearchStore((s) => s.isSearching);
  const goToPage = useSearchStore((s) => s.goToPage);
  const setPageSize = useSearchStore((s) => s.setPageSize);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
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
                <HighlightedText text={result.file.file_name} terms={result.highlight_terms} />
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
                  <HighlightedText text={result.snippet} terms={result.highlight_terms} />
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
      {totalPages > 0 && (
        <nav className="flex h-11 shrink-0 items-center gap-2 border-t border-surface-200 px-4 text-xs text-surface-500 dark:border-surface-800" aria-label={t('search.pagination')}>
          <span className="mr-auto tabular-nums">{t('search.pageSummary', { page: page + 1, pages: totalPages, total })}</span>
          <label className="flex items-center gap-1.5">
            <span>{t('search.pageSize')}</span>
            <select
              className="h-7 rounded border border-surface-200 bg-white px-1.5 text-xs dark:border-surface-700 dark:bg-surface-900"
              value={pageSize}
              disabled={isSearching}
              onChange={(event) => void setPageSize(Number(event.target.value))}
            >
              {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <button type="button" className="icon-button" disabled={isSearching || page === 0} onClick={() => void goToPage(page - 1)} title={t('search.previousPage')} aria-label={t('search.previousPage')}>
            <ChevronLeft size={15} />
          </button>
          <button type="button" className="icon-button" disabled={isSearching || page + 1 >= totalPages} onClick={() => void goToPage(page + 1)} title={t('search.nextPage')} aria-label={t('search.nextPage')}>
            <ChevronRight size={15} />
          </button>
        </nav>
      )}
    </div>
  );
}

export function HighlightedText({ text, terms }: { text: string; terms: string[] }) {
  const normalizedTerms = [...new Set(terms.map((term) => term.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  if (normalizedTerms.length === 0 || !text) return text;

  const lowerText = text.toLocaleLowerCase();
  const lowerTerms = normalizedTerms.map((term) => term.toLocaleLowerCase());
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    let matchIndex = -1;
    let matchLength = 0;
    for (const term of lowerTerms) {
      const index = lowerText.indexOf(term, cursor);
      if (index >= 0 && (matchIndex < 0 || index < matchIndex || (index === matchIndex && term.length > matchLength))) {
        matchIndex = index;
        matchLength = term.length;
      }
    }
    if (matchIndex < 0) break;
    if (matchIndex > cursor) parts.push(text.slice(cursor, matchIndex));
    parts.push(
      <mark key={key++} className="rounded-sm bg-amber-200 px-0.5 text-inherit dark:bg-amber-700/60">
        {text.slice(matchIndex, matchIndex + matchLength)}
      </mark>
    );
    cursor = matchIndex + matchLength;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : text;
}
