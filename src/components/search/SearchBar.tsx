import { useEffect, useRef } from 'react';
import { useSearchStore } from '../../stores/searchStore';
import { Search, X } from 'lucide-react';

export function SearchBar() {
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const doSearch = useSearchStore((s) => s.doSearch);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch();
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

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
        placeholder="Search PDFs by name or content... (use name:, ext:, size: filters)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') doSearch();
        }}
      />
      {query && (
        <button
          onClick={() => setQuery('')}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-surface-400 hover:text-surface-600"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
