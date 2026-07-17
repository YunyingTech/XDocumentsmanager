import { useState, useEffect, useCallback } from 'react';
import { useSearchStore } from '../../stores/searchStore';
import { SearchBar } from './SearchBar';
import { SearchResults } from './SearchResults';
import { EmptyState } from '../common/EmptyState';
import { Search } from 'lucide-react';

export function SearchView() {
  const query = useSearchStore((s) => s.query);
  const results = useSearchStore((s) => s.results);
  const isSearching = useSearchStore((s) => s.isSearching);
  const doSearch = useSearchStore((s) => s.doSearch);

  return (
    <div className="flex flex-col h-full">
      {/* Search header */}
      <div className="flex items-center gap-4 px-4 h-12 border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950">
        <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
          Search
        </h2>
        <div className="flex-1 max-w-xl">
          <SearchBar />
        </div>
        {results.length > 0 && (
          <span className="text-xs text-surface-400">
            {results.length} result{results.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto">
        {!query.trim() ? (
          <EmptyState
            icon={Search}
            title="Search your PDFs"
            description="Search across file names and full text content of all indexed PDFs."
          />
        ) : isSearching ? (
          <div className="flex items-center justify-center h-32 text-sm text-surface-500">
            Searching...
          </div>
        ) : results.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No results found"
            description={`No PDFs matched "${query}". Try different keywords or check your spelling.`}
          />
        ) : (
          <SearchResults />
        )}
      </div>
    </div>
  );
}
