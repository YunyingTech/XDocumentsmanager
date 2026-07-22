import { useSearchStore } from '../../stores/searchStore';
import { SearchBar } from './SearchBar';
import { SearchResults } from './SearchResults';
import { PdfViewer } from '../viewer/PdfViewer';
import { EmptyState } from '../common/EmptyState';
import { AlertCircle, BrainCircuit, Check, DatabaseZap, FileSearch, Search } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../lib/i18n';

const stages = [
  { id: 'analyzing', label: 'search.stageAnalyzing', icon: BrainCircuit, threshold: 15 },
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
  const selectedResult = results.find((result) => result.file.id === selectedResultId);

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
        {results.length > 0 && (
          <span className="text-xs text-surface-400">
            {plural('search.resultCount', results.length)}
          </span>
        )}
      </div>

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
          <span className="ml-auto font-mono text-[11px] tabular-nums text-surface-400">{progress.progress}%</span>
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
