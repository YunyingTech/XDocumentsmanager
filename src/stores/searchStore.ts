import { create } from 'zustand';
import type { SearchResult, SearchFilters, SearchProgress } from '../types';
import { search } from '../lib/tauri';

interface SearchStore {
  query: string;
  results: SearchResult[];
  filters: SearchFilters;
  isSearching: boolean;
  progress: SearchProgress | null;
  error: string | null;
  isOpen: boolean;
  selectedResultId: number | null;

  setQuery: (q: string) => void;
  setFilters: (f: SearchFilters) => void;
  doSearch: () => Promise<void>;
  updateProgress: (progress: SearchProgress) => void;
  selectResult: (fileId: number | null) => void;
  toggleOpen: () => void;
  clearSearch: () => void;
}

let latestSearchRequest = 0;

export const useSearchStore = create<SearchStore>((set, get) => ({
  query: '',
  results: [],
  filters: {},
  isSearching: false,
  progress: null,
  error: null,
  isOpen: false,
  selectedResultId: null,

  setQuery: (query) => set({ query, error: null }),

  setFilters: (filters) => set({ filters }),

  doSearch: async () => {
    const requestId = ++latestSearchRequest;
    const { query, filters } = get();
    if (!query.trim()) {
      set({ results: [], selectedResultId: null, isSearching: false, progress: null, error: null });
      return;
    }
    set({
      isSearching: true,
      selectedResultId: null,
      progress: { request_id: requestId, stage: 'preparing', progress: 5 },
      error: null,
    });
    try {
      const results = await search(query, filters, 100, requestId);
      if (requestId === latestSearchRequest) {
        set({
          results,
          isSearching: false,
          progress: { request_id: requestId, stage: 'completed', progress: 100 },
        });
      }
    } catch (err) {
      console.error('Search failed:', err);
      if (requestId === latestSearchRequest) {
        set({
          isSearching: false,
          progress: { request_id: requestId, stage: 'failed', progress: 100 },
          error: String(err),
        });
      }
    }
  },

  updateProgress: (progress) => {
    if (progress.request_id === latestSearchRequest) set({ progress });
  },

  selectResult: (selectedResultId) => set({ selectedResultId }),

  toggleOpen: () => set({ isOpen: !get().isOpen }),

  clearSearch: () => {
    latestSearchRequest += 1;
    set({ query: '', results: [], filters: {}, isOpen: false, selectedResultId: null, isSearching: false, progress: null, error: null });
  },
}));
