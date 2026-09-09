import { create } from 'zustand';
import type { SearchResult, SearchFilters, SearchProgress, SearchQueryAnalysis } from '../types';
import { analyzeSearchQuery, search } from '../lib/tauri';

interface SearchStore {
  query: string;
  results: SearchResult[];
  filters: SearchFilters;
  isSearching: boolean;
  progress: SearchProgress | null;
  error: string | null;
  isOpen: boolean;
  selectedResultId: number | null;
  analysis: SearchQueryAnalysis | null;
  selectedTerms: string[];
  isAnalyzing: boolean;
  analysisError: string | null;
  searchElapsedMs: number | null;
  searchStartedAt: number | null;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  activeTerms: string[];
  activeQueryModel: string | null;

  setQuery: (q: string) => void;
  setFilters: (f: SearchFilters) => void;
  doSearch: (terms?: string[], queryModel?: string, page?: number) => Promise<void>;
  goToPage: (page: number) => Promise<void>;
  setPageSize: (pageSize: number) => Promise<void>;
  analyzeQuery: () => Promise<void>;
  toggleTerm: (term: string) => void;
  selectAllTerms: (selected: boolean) => void;
  searchSelectedTerms: () => Promise<void>;
  updateProgress: (progress: SearchProgress) => void;
  selectResult: (fileId: number | null) => void;
  toggleOpen: () => void;
  clearSearch: () => void;
}

let latestSearchRequest = 0;
let latestAnalysisRequest = 0;

export const useSearchStore = create<SearchStore>((set, get) => ({
  query: '',
  results: [],
  filters: {},
  isSearching: false,
  progress: null,
  error: null,
  isOpen: false,
  selectedResultId: null,
  analysis: null,
  selectedTerms: [],
  isAnalyzing: false,
  analysisError: null,
  searchElapsedMs: null,
  searchStartedAt: null,
  page: 0,
  pageSize: 25,
  total: 0,
  totalPages: 0,
  activeTerms: [],
  activeQueryModel: null,

  setQuery: (query) => {
    latestAnalysisRequest += 1;
    set({ query, error: null, analysis: null, selectedTerms: [], analysisError: null, isAnalyzing: false, page: 0, total: 0, totalPages: 0, activeTerms: [], activeQueryModel: null });
  },

  setFilters: (filters) => set({ filters }),

  doSearch: async (terms, queryModel, requestedPage = 0) => {
    const requestId = ++latestSearchRequest;
    const { query, filters, pageSize } = get();
    const page = Math.max(0, Math.trunc(requestedPage));
    const activeTerms = terms ?? [];
    const activeQueryModel = queryModel ?? null;
    if (!query.trim()) {
      set({ results: [], selectedResultId: null, isSearching: false, progress: null, error: null, searchElapsedMs: null, searchStartedAt: null, page: 0, total: 0, totalPages: 0, activeTerms: [], activeQueryModel: null });
      return;
    }
    set({
      isSearching: true,
      selectedResultId: null,
      progress: { request_id: requestId, stage: 'preparing', progress: 5 },
      error: null,
      searchElapsedMs: null,
      searchStartedAt: Date.now(),
      activeTerms,
      activeQueryModel,
    });
    try {
      const response = await search(query, filters, page, pageSize, requestId, activeTerms, activeQueryModel ?? undefined);
      if (requestId === latestSearchRequest) {
        set({
          results: response.results,
          isSearching: false,
          progress: { request_id: requestId, stage: 'completed', progress: 100 },
          searchElapsedMs: response.elapsed_ms,
          searchStartedAt: null,
          page: response.page,
          pageSize: response.page_size,
          total: response.total,
          totalPages: response.total_pages,
        });
      }
    } catch (err) {
      console.error('Search failed:', err);
      if (requestId === latestSearchRequest) {
        set({
          isSearching: false,
          progress: { request_id: requestId, stage: 'failed', progress: 100 },
          error: String(err),
          searchStartedAt: null,
        });
      }
    }
  },

  goToPage: async (page) => {
    const { totalPages, activeTerms, activeQueryModel } = get();
    if (totalPages === 0) return;
    const nextPage = Math.min(totalPages - 1, Math.max(0, Math.trunc(page)));
    await get().doSearch(activeTerms, activeQueryModel ?? undefined, nextPage);
  },

  setPageSize: async (pageSize) => {
    const nextSize = [10, 25, 50, 100].includes(pageSize) ? pageSize : 25;
    set({ pageSize: nextSize });
    const { activeTerms, activeQueryModel } = get();
    await get().doSearch(activeTerms, activeQueryModel ?? undefined, 0);
  },

  analyzeQuery: async () => {
    const requestId = ++latestAnalysisRequest;
    const query = get().query.trim();
    if (!query) return;
    set({ isAnalyzing: true, analysisError: null, analysis: null, selectedTerms: [] });
    try {
      const analysis = await analyzeSearchQuery(query);
      if (requestId === latestAnalysisRequest) {
        set({ analysis, selectedTerms: analysis.terms, isAnalyzing: false });
      }
    } catch (error) {
      if (requestId === latestAnalysisRequest) {
        set({ isAnalyzing: false, analysisError: String(error) });
      }
    }
  },

  toggleTerm: (term) => set((state) => ({
    selectedTerms: state.selectedTerms.includes(term)
      ? state.selectedTerms.filter((candidate) => candidate !== term)
      : [...state.selectedTerms, term],
  })),

  selectAllTerms: (selected) => set((state) => ({
    selectedTerms: selected ? state.analysis?.terms ?? [] : [],
  })),

  searchSelectedTerms: async () => {
    const { selectedTerms, analysis } = get();
    if (selectedTerms.length > 0) await get().doSearch(selectedTerms, analysis?.model);
  },

  updateProgress: (progress) => {
    if (progress.request_id === latestSearchRequest) set({ progress });
  },

  selectResult: (selectedResultId) => set({ selectedResultId }),

  toggleOpen: () => set({ isOpen: !get().isOpen }),

  clearSearch: () => {
    latestSearchRequest += 1;
    latestAnalysisRequest += 1;
    set({ query: '', results: [], filters: {}, isOpen: false, selectedResultId: null, isSearching: false, progress: null, error: null, analysis: null, selectedTerms: [], isAnalyzing: false, analysisError: null, searchElapsedMs: null, searchStartedAt: null, page: 0, total: 0, totalPages: 0, activeTerms: [], activeQueryModel: null });
  },
}));
