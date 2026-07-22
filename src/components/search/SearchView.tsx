import { useSearchStore } from '../../stores/searchStore';
import { SearchBar } from './SearchBar';
import { SearchResults } from './SearchResults';
import { EmptyState } from '../common/EmptyState';
import { Search } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

export function SearchView() {
  const { t, plural } = useI18n();
  const query = useSearchStore((s) => s.query);
  const results = useSearchStore((s) => s.results);
  const isSearching = useSearchStore((s) => s.isSearching);

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

      {/* Results */}
      <div className="flex-1 overflow-auto">
        {!query.trim() ? (
          <EmptyState
            icon={Search}
            title={t('search.emptyTitle')}
            description={t('search.emptyHint')}
          />
        ) : isSearching ? (
          <div className="flex items-center justify-center h-32 text-sm text-surface-500">
            {t('search.searching')}
          </div>
        ) : results.length === 0 ? (
          <EmptyState
            icon={Search}
            title={t('search.noResults')}
            description={t('search.noResultsHint', { query })}
          />
        ) : (
          <SearchResults />
        )}
      </div>
    </div>
  );
}
