import { useEffect, useRef } from 'react';
import { useSearchStore } from '../../stores/searchStore';
import { Search, X } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

export function SearchBar() {
  const { t } = useI18n();
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const doSearch = useSearchStore((s) => s.doSearch);
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
    <div className="relative">
      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
      <input
        ref={inputRef}
        type="text"
        className="input pl-9 pr-8"
        placeholder={t('search.placeholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') runSearch();
        }}
      />
      {query && (
        <button
          onClick={() => setQuery('')}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-surface-400 hover:text-surface-600"
          title={t('search.clear')}
          aria-label={t('search.clear')}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
