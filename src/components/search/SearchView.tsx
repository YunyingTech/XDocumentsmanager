import { useEffect, useState } from 'react';
import { useSearchStore } from '../../stores/searchStore';
import { SearchBar } from './SearchBar';
import { SearchResults } from './SearchResults';
import { PdfViewer } from '../viewer/PdfViewer';
import { EmptyState } from '../common/EmptyState';
import { AlertCircle, Check, DatabaseZap, FileSearch, ListFilter, LoaderCircle, Search, Sparkles } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../lib/i18n';
import type { SearchQueryAnalysis } from '../../types';

const stages = [
  { id: 'searching', label: 'search.stageSearching', icon: DatabaseZap, threshold: 50 },
  { id: 'resolving', label: 'search.stageResolving', icon: FileSearch, threshold: 78 },
] as const satisfies ReadonlyArray<{ id: string; label: TranslationKey; icon: typeof Search; threshold: number }>;

export function SearchView() {
  const { t, plural } = useI18n();
  const query = useSearchStore((s) => s.query);
  const results = useSearchStore((s) => s.results);
  const isSearching = useSearchStore((s) => s.isSearching);
  const progress = useSearchStore((s) => s.progress);
  const error = useSearchStore((s) => s.error);
  const selectedResultId = useSearchStore((s) => s.selectedResultId);
  const selectResult = useSearchStore((s) => s.selectResult);
  const analysis = useSearchStore((s) => s.analysis);
  const selectedTerms = useSearchStore((s) => s.selectedTerms);
  const isAnalyzing = useSearchStore((s) => s.isAnalyzing);
  const analysisError = useSearchStore((s) => s.analysisError);
  const toggleTerm = useSearchStore((s) => s.toggleTerm);
  const selectAllTerms = useSearchStore((s) => s.selectAllTerms);
  const searchSelectedTerms = useSearchStore((s) => s.searchSelectedTerms);
  const searchElapsedMs = useSearchStore((s) => s.searchElapsedMs);
  const searchStartedAt = useSearchStore((s) => s.searchStartedAt);
  const [clock, setClock] = useState(Date.now());
  const [expandedAnalysis, setExpandedAnalysis] = useState<SearchQueryAnalysis | null>(null);
  const selectedResult = results.find((result) => result.file.id === selectedResultId);
  const elapsedMs = isSearching && searchStartedAt ? clock - searchStartedAt : searchElapsedMs;
  const termsExpanded = analysis !== null && expandedAnalysis === analysis;

  useEffect(() => {
    if (!isSearching) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [isSearching]);

  return (
    <div className="flex flex-col h-full">
      {/* Search header */}
      <div className="flex items-center gap-4 px-4 h-12 border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950">
        <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
          {t('nav.search')}
        </h2>
        <div className="flex-1 max-w-xl">
          <SearchBar />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-surface-400">
          {results.length > 0 && <span>{plural('search.resultCount', results.length)}</span>}
          {elapsedMs !== null && <span className="font-mono tabular-nums">{t('search.duration', { duration: formatDuration(elapsedMs) })}</span>}
        </div>
      </div>

      {(isAnalyzing || analysis || analysisError) && (
        <div className="shrink-0 border-b border-surface-200 bg-white px-4 py-3 dark:border-surface-800 dark:bg-surface-950">
          {isAnalyzing ? (
            <div className="flex h-8 items-center gap-2 text-xs text-accent-700 dark:text-accent-300" role="status">
              <LoaderCircle size={15} className="animate-spin" />
              <span>{t('search.analyzing')}</span>
            </div>
          ) : analysisError ? (
            <div className="flex h-8 items-center gap-2 text-xs text-red-600 dark:text-red-400" role="alert">
              <AlertCircle size={15} />
              <span className="truncate" title={analysisError}>{t('search.analysisFailed', { error: analysisError })}</span>
            </div>
          ) : analysis && (
            <div>
              <div className="flex min-h-8 flex-wrap items-center gap-2">
                <div className="mr-1 flex min-w-0 items-center gap-2 text-xs text-surface-500">
                  <Sparkles size={15} className="shrink-0 text-accent-500" />
                  <span className="font-medium text-surface-700 dark:text-surface-300">{t('search.suggestedTerms')}</span>
                  <span className="max-w-36 truncate font-mono text-[11px] text-surface-400" title={analysis.model}>{analysis.model}</span>
                  <span className="font-mono text-[11px] tabular-nums text-surface-400">{formatDuration(analysis.elapsed_ms)}</span>
                  <span className="text-[11px] tabular-nums text-surface-400">{t('search.termCount', { count: analysis.terms.length })}</span>
                </div>
                <button
                  type="button"
                  className="btn-ghost ml-auto flex h-7 items-center gap-1.5 px-2 text-xs"
                  aria-expanded={termsExpanded}
                  aria-controls="ai-search-term-filters"
                  onClick={() => setExpandedAnalysis(termsExpanded ? null : analysis)}
                >
                  <ListFilter size={13} />
                  <span>{termsExpanded ? t('search.collapseTerms') : t('search.filterTerms')}</span>
                </button>
              </div>
              {termsExpanded && (
                <div id="ai-search-term-filters" className="mt-2 flex flex-wrap items-center gap-2 border-t border-surface-100 pt-2 dark:border-surface-800">
                  {analysis.terms.map((term) => (
                    <label key={term} className={`flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-xs transition-colors ${selectedTerms.includes(term) ? 'border-accent-400 bg-accent-50 text-accent-800 dark:border-accent-600 dark:bg-accent-950/30 dark:text-accent-200' : 'border-surface-200 text-surface-500 dark:border-surface-700'}`}>
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-accent-600"
                        checked={selectedTerms.includes(term)}
                        onChange={() => toggleTerm(term)}
                      />
                      <span>{term}</span>
                    </label>
                  ))}
                  <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => selectAllTerms(selectedTerms.length !== analysis.terms.length)}>
                    {selectedTerms.length === analysis.terms.length ? t('search.clearTerms') : t('search.selectAllTerms')}
                  </button>
                  <button type="button" className="btn-primary flex h-7 items-center gap-1.5 px-2.5 text-xs disabled:opacity-50" disabled={selectedTerms.length === 0 || isSearching} onClick={() => void searchSelectedTerms()}>
                    <Search size={13} />
                    <span>{t('search.searchSelected', { count: selectedTerms.length })}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isSearching && progress && (
        <div className="relative flex h-11 shrink-0 items-center border-b border-surface-200 bg-surface-50 px-4 dark:border-surface-800 dark:bg-surface-900/60" role="status" aria-label={t('search.progressLabel')}>
          <div className="flex w-full max-w-2xl items-center gap-6">
            {stages.map(({ id, label, icon: Icon, threshold }) => {
              const active = progress.stage === id;
              const complete = progress.progress > threshold;
              return (
                <div key={id} className={`flex min-w-0 items-center gap-1.5 text-xs ${active ? 'font-semibold text-accent-700 dark:text-accent-300' : complete ? 'text-emerald-600 dark:text-emerald-400' : 'text-surface-400'}`}>
                  {complete ? <Check size={13} /> : <Icon size={13} className={active ? 'animate-pulse' : ''} />}
                  <span className="truncate">{t(label)}</span>
                </div>
              );
            })}
          </div>
          <span className="ml-auto font-mono text-[11px] tabular-nums text-surface-400">{progress.progress}%{elapsedMs !== null ? ` / ${formatDuration(elapsedMs)}` : ''}</span>
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-surface-200 dark:bg-surface-800">
            <div className="h-full bg-accent-500 transition-[width] duration-300" style={{ width: `${progress.progress}%` }} />
          </div>
        </div>
      )}

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {!query.trim() ? (
          <EmptyState
            icon={Search}
            title={t('search.emptyTitle')}
            description={t('search.emptyHint')}
          />
        ) : isSearching ? (
          <div className="h-full overflow-auto divide-y divide-surface-100 px-4 dark:divide-surface-900">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex gap-3 py-4">
                <div className="h-8 w-8 shrink-0 animate-pulse rounded-md bg-surface-200 dark:bg-surface-800" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-3 animate-pulse rounded-sm bg-surface-200 dark:bg-surface-800" style={{ width: `${36 + index * 7}%` }} />
                  <div className="h-2.5 w-4/5 animate-pulse rounded-sm bg-surface-100 dark:bg-surface-900" />
                  <div className="h-2.5 w-2/3 animate-pulse rounded-sm bg-surface-100 dark:bg-surface-900" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="flex h-32 items-center justify-center gap-2 px-4 text-sm text-red-600 dark:text-red-400">
            <AlertCircle size={16} />
            <span className="max-w-xl truncate" title={error}>{t('search.failedWithReason', { error })}</span>
          </div>
        ) : results.length === 0 ? (
          <EmptyState
            icon={Search}
            title={t('search.noResults')}
            description={t('search.noResultsHint', { query })}
          />
        ) : (
          <div className={`grid h-full min-h-0 ${selectedResult ? 'md:grid-cols-[minmax(280px,38%)_minmax(0,1fr)]' : ''}`}>
            <div className={`min-h-0 overflow-auto ${selectedResult ? 'hidden border-r border-surface-200 md:block dark:border-surface-800' : ''}`}>
              <SearchResults />
            </div>
            {selectedResult && (
              <div className="min-h-0 min-w-0">
                <PdfViewer
                  filePath={selectedResult.absolute_path}
                  fileName={selectedResult.file.file_name}
                  mode="embedded"
                  onClose={() => selectResult(null)}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(1, Math.round(milliseconds))} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}
