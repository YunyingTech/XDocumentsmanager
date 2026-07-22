import { create } from 'zustand';
import type { SearchResult, SearchFilters } from '../types';
import { search } from '../lib/tauri';

interface SearchStore {
  query: string;
  results: SearchResult[];
  filters: SearchFilters;
  isSearching: boolean;
  isOpen: boolean;

  setQuery: (q: string) => void;
  setFilters: (f: SearchFilters) => void;
  doSearch: () => Promise<void>;
  toggleOpen: () => void;
  clearSearch: () => void;
}

let latestSearchRequest = 0;

export const useSearchStore = create<SearchStore>((set, get) => ({
  query: '',
  results: [],
  filters: {},
  isSearching: false,
  isOpen: false,

  setQuery: (query) => set({ query }),

  setFilters: (filters) => set({ filters }),

  doSearch: async () => {
    const requestId = ++latestSearchRequest;
    const { query, filters } = get();
    if (!query.trim()) {
      set({ results: [], isSearching: false });
      return;
    }
    set({ isSearching: true });
    try {
      const results = await search(query, filters);
      if (requestId === latestSearchRequest) set({ results, isSearching: false });
    } catch (err) {
      console.error('Search failed:', err);
      if (requestId === latestSearchRequest) set({ isSearching: false });
    }
  },

  toggleOpen: () => set({ isOpen: !get().isOpen }),

  clearSearch: () => set({ query: '', results: [], filters: {}, isOpen: false }),
}));
