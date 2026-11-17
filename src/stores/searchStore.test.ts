import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchQueryAnalysis, SearchResponse } from '../types';
import { fileFixture, searchResultFixture } from '../test/fixtures';

const mocks = vi.hoisted(() => ({
  analyzeSearchQuery: vi.fn(),
  search: vi.fn(),
}));
vi.mock('../lib/tauri', () => mocks);

import { useSearchStore } from './searchStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('search store', () => {
  beforeEach(() => {
    mocks.search.mockReset();
    mocks.analyzeSearchQuery.mockReset();
    useSearchStore.setState({
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
    });
  });

  it('does not call the backend for a blank query', async () => {
    useSearchStore.getState().setQuery('   ');
    await useSearchStore.getState().doSearch();
    expect(mocks.search).not.toHaveBeenCalled();
    expect(useSearchStore.getState()).toMatchObject({ results: [], isSearching: false, error: null });
  });

  it('forwards selected AI terms and records the completed result', async () => {
    const response: SearchResponse = {
      results: [searchResultFixture(fileFixture({ id: 7 }))],
      elapsed_ms: 17,
      total: 51,
      page: 0,
      page_size: 25,
      total_pages: 3,
    };
    mocks.search.mockResolvedValue(response);
    useSearchStore.getState().setQuery('compliance report');
    useSearchStore.getState().setFilters({ folder_id: 10 });

    await useSearchStore.getState().doSearch(['audit', 'risk'], 'gpt-test');

    expect(mocks.search).toHaveBeenCalledWith(
      'compliance report',
      { folder_id: 10 },
      0,
      25,
      expect.any(Number),
      ['audit', 'risk'],
      'gpt-test',
    );
    expect(useSearchStore.getState()).toMatchObject({
      results: response.results,
      isSearching: false,
      searchElapsedMs: 17,
      selectedResultId: null,
    });
    expect(useSearchStore.getState().progress?.stage).toBe('completed');
  });

  it('ignores a stale search response that finishes last', async () => {
    const first = deferred<SearchResponse>();
    const second = deferred<SearchResponse>();
    mocks.search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useSearchStore.getState().setQuery('first');
    const firstSearch = useSearchStore.getState().doSearch();
    useSearchStore.getState().setQuery('second');
    const secondSearch = useSearchStore.getState().doSearch();

    second.resolve({ results: [searchResultFixture(fileFixture({ id: 2 }))], elapsed_ms: 2, total: 1, page: 0, page_size: 25, total_pages: 1 });
    await secondSearch;
    first.resolve({ results: [searchResultFixture(fileFixture({ id: 1 }))], elapsed_ms: 20, total: 1, page: 0, page_size: 25, total_pages: 1 });
    await firstSearch;

    expect(useSearchStore.getState().results[0].file.id).toBe(2);
    expect(useSearchStore.getState().searchElapsedMs).toBe(2);
  });

  it('invalidates an in-flight result when the query changes without submitting again', async () => {
    const pending = deferred<SearchResponse>();
    mocks.search.mockReturnValue(pending.promise);
    useSearchStore.getState().setQuery('old');
    const request = useSearchStore.getState().doSearch();
    useSearchStore.getState().setQuery('new');
    pending.resolve({ results: [searchResultFixture()], elapsed_ms: 1, total: 1, page: 0, page_size: 25, total_pages: 1 });
    await request;
    expect(useSearchStore.getState()).toMatchObject({ query: 'new', results: [], isSearching: false, progress: null });
  });

  it('restarts scoped folder searches on the first page, preserving AI terms and discarding old hits', async () => {
    const old = deferred<SearchResponse>();
    const current = deferred<SearchResponse>();
    mocks.search.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    useSearchStore.getState().setQuery('audit');
    const first = useSearchStore.getState().doSearch(['审计'], 'test-model', 3);
    useSearchStore.getState().setFilters({ scope: 'title', folder_id: 10 });
    expect(mocks.search).toHaveBeenLastCalledWith('audit', { scope: 'title', folder_id: 10 }, 0, 25, expect.any(Number), ['审计'], 'test-model');
    old.resolve({ results: [searchResultFixture(fileFixture({ id: 99 }))], elapsed_ms: 10, total: 100, page: 3, page_size: 25, total_pages: 4 });
    await first;
    expect(useSearchStore.getState().results).toEqual([]);
    current.resolve({ results: [], elapsed_ms: 1, total: 0, page: 0, page_size: 25, total_pages: 0 });
    await vi.waitFor(() => expect(useSearchStore.getState().isSearching).toBe(false));
    expect(useSearchStore.getState()).toMatchObject({ filters: { scope: 'title', folder_id: 10 }, results: [], total: 0, page: 0 });
  });

  it('uses the latest analysis and searches selected terms with its model', async () => {
    const analysis: SearchQueryAnalysis = { terms: ['supplier', 'risk'], elapsed_ms: 3, model: 'gpt-test' };
    mocks.analyzeSearchQuery.mockResolvedValue(analysis);
    mocks.search.mockResolvedValue({ results: [], elapsed_ms: 1, total: 0, page: 0, page_size: 25, total_pages: 0 });
    useSearchStore.getState().setQuery('supplier review');

    await useSearchStore.getState().analyzeQuery();
    expect(useSearchStore.getState()).toMatchObject({ analysis, selectedTerms: analysis.terms, isAnalyzing: false });
    useSearchStore.getState().toggleTerm('supplier');
    await useSearchStore.getState().searchSelectedTerms();

    expect(mocks.search).toHaveBeenCalledWith(
      'supplier review',
      {},
      0,
      25,
      expect.any(Number),
      ['risk'],
      'gpt-test',
    );
  });

  it('loads another page with the active AI terms and ignores stale page responses', async () => {
    mocks.search.mockResolvedValue({ results: [searchResultFixture(fileFixture({ id: 26 }))], elapsed_ms: 4, total: 60, page: 1, page_size: 25, total_pages: 3 });
    useSearchStore.setState({ query: 'risk', total: 60, totalPages: 3, activeTerms: ['audit'], activeQueryModel: 'gpt-test' });

    await useSearchStore.getState().goToPage(1);

    expect(mocks.search).toHaveBeenCalledWith('risk', {}, 1, 25, expect.any(Number), ['audit'], 'gpt-test');
    expect(useSearchStore.getState()).toMatchObject({ page: 1, total: 60, totalPages: 3 });
  });
});
