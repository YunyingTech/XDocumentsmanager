import { useEffect, useRef } from 'react';
import { useSearchStore } from '../../stores/searchStore';
import { Search, Sparkles, X } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

export function SearchBar() {
  const { t } = useI18n();
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const doSearch = useSearchStore((s) => s.doSearch);
  const analyzeQuery = useSearchStore((s) => s.analyzeQuery);
  const isAnalyzing = useSearchStore((s) => s.isAnalyzing);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const runSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void doSearch();
  };

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void doSearch();
    }, 650);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, doSearch]);

  // Focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form className="relative" role="search" onSubmit={(event) => { event.preventDefault(); runSearch(); }}>
      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        name="pdf_search"
        autoComplete="off"
        aria-label={t('common.search')}
        className="input pl-9 pr-16"
        placeholder={t('search.placeholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query && (
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          <button
            type="button"
            onClick={() => void analyzeQuery()}
            disabled={isAnalyzing}
            className="icon-button h-7 w-7 text-accent-600 disabled:opacity-50 dark:text-accent-400"
            title={t('search.analyze')}
            aria-label={t('search.analyze')}
          >
            <Sparkles size={14} className={isAnalyzing ? 'animate-pulse' : ''} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setQuery('')}
            className="icon-button h-7 w-7"
            title={t('search.clear')}
            aria-label={t('search.clear')}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </form>
  );
}
