import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fileFixture, folderFixture, searchResultFixture } from '../../test/fixtures';

const tauri = vi.hoisted(() => ({
  analyzeSearchQuery: vi.fn(),
  search: vi.fn(),
  showInFolder: vi.fn(),
}));

vi.mock('../../lib/tauri', () => tauri);
vi.mock('../viewer/PdfViewer', () => ({
  PdfViewer: ({ filePath, fileName, onClose }: { filePath: string; fileName: string; onClose: () => void }) => (
    <div data-testid="pdf-preview">
      <span>{fileName}</span>
      <span>{filePath}</span>
      <button type="button" onClick={onClose}>Close preview</button>
    </div>
  ),
}));

import { useSearchStore } from '../../stores/searchStore';
import { useUIStore } from '../../stores/uiStore';
import { useFolderStore } from '../../stores/folderStore';
import { SearchView } from './SearchView';

describe('search result workflow', () => {
  beforeEach(() => {
    Object.values(tauri).forEach((mock) => mock.mockReset());
    tauri.showInFolder.mockResolvedValue(undefined);
    useUIStore.setState({ language: 'en' });
    useFolderStore.setState({ folders: [folderFixture(), folderFixture({ id: 20, display_name: 'Documents', path: '\\\\nas\\archive' })] });
    useSearchStore.setState({
      query: 'audit',
      results: [],
      filters: {},
      isSearching: false,
      progress: null,
      error: null,
      isOpen: true,
      selectedResultId: null,
      analysis: null,
      selectedTerms: [],
      isAnalyzing: false,
      analysisError: null,
      searchElapsedMs: 12,
      searchStartedAt: null,
      page: 0,
      pageSize: 25,
      total: 0,
      totalPages: 0,
      activeTerms: [],
      activeQueryModel: null,
    });
  });

  it('combines title/content scope and folder selection, and can reset to all folders', async () => {
    const user = userEvent.setup();
    tauri.search.mockResolvedValue({ results: [], elapsed_ms: 1, total: 0, page: 0, page_size: 25, total_pages: 0 });
    render(<SearchView />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Search in' }), 'title');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Folder' }), '20');
    expect(useSearchStore.getState().filters).toEqual({ scope: 'title', folder_id: 20 });
    expect(screen.getByRole('option', { name: /Documents.*nas/ })).toBeInTheDocument();
    await useSearchStore.getState().doSearch();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Search in' }), 'content');
    expect(tauri.search).toHaveBeenLastCalledWith('audit', { scope: 'content', folder_id: 20 }, 0, 25, expect.any(Number), [], undefined);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Folder' }), '');
    expect(useSearchStore.getState().filters).toEqual({ scope: 'content', folder_id: undefined });
  });

  it('opens the selected PDF in the embedded right-side preview and can close it', async () => {
    const result = searchResultFixture(fileFixture({ id: 7, file_name: 'audit.pdf' }));
    useSearchStore.setState({ results: [result] });
    const user = userEvent.setup();
    render(<SearchView />);

    await user.click(screen.getByRole('button', { name: 'Preview: audit.pdf' }));
    expect(useSearchStore.getState().selectedResultId).toBe(7);
    expect(screen.getByTestId('pdf-preview')).toHaveTextContent(result.absolute_path);

    await user.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(useSearchStore.getState().selectedResultId).toBeNull();
  });

  it('opens the source folder without selecting the search result', async () => {
    const result = {
      ...searchResultFixture(fileFixture({ id: 8, file_name: 'security.pdf' })),
      matched_terms: ['security', 'audit', 'risk', 'compliance'],
      highlight_terms: ['security'],
      match_model: 'gpt-test',
    };
    useSearchStore.setState({ results: [result] });
    const user = userEvent.setup();
    render(<SearchView />);

    expect(screen.getByText('gpt-test')).toBeInTheDocument();
    expect(screen.getByText('security', { selector: 'mark' })).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open containing folder' }));

    expect(tauri.showInFolder).toHaveBeenCalledWith(result.absolute_path);
    expect(useSearchStore.getState().selectedResultId).toBeNull();
  });

  it('shows folder errors without losing results, and lets the user retry', async () => {
    const result = searchResultFixture(fileFixture({ id: 9, file_name: 'report.pdf' }));
    useSearchStore.setState({ results: [result] });
    tauri.showInFolder.mockRejectedValueOnce('The file was moved or is unavailable');
    const user = userEvent.setup();
    render(<SearchView />);

    await user.click(screen.getByRole('button', { name: 'Open containing folder' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The file was moved or is unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent(result.absolute_path);
    expect(screen.getByRole('button', { name: 'Preview: report.pdf' })).toBeInTheDocument();
    expect(useSearchStore.getState().selectedResultId).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Open containing folder' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(tauri.showInFolder).toHaveBeenCalledTimes(2);
  });

  it('prevents duplicate folder opens while the native operation is pending', async () => {
    const result = searchResultFixture(fileFixture({ id: 10, file_name: 'report.pdf' }));
    useSearchStore.setState({ results: [result] });
    let finish!: () => void;
    tauri.showInFolder.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<SearchView />);
    const button = screen.getByRole('button', { name: 'Open containing folder' });

    await user.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    expect(tauri.showInFolder).toHaveBeenCalledTimes(1);

    await act(async () => { finish(); });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('requests the next result page with the active search context', async () => {
    const first = searchResultFixture(fileFixture({ id: 1, file_name: 'audit.pdf' }));
    const next = searchResultFixture(fileFixture({ id: 26, file_name: 'audit-26.pdf' }));
    useSearchStore.setState({
      results: [first],
      total: 30,
      totalPages: 2,
      page: 0,
      pageSize: 25,
      activeTerms: ['audit'],
      activeQueryModel: 'gpt-test',
    });
    tauri.search.mockResolvedValue({
      results: [next],
      elapsed_ms: 3,
      total: 30,
      page: 1,
      page_size: 25,
      total_pages: 2,
    });
    const user = userEvent.setup();
    render(<SearchView />);

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    expect(tauri.search).toHaveBeenCalledWith('audit', {}, 1, 25, expect.any(Number), ['audit'], 'gpt-test');
    expect(await screen.findByText('audit-26.pdf')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 2 · 30 results')).toBeInTheDocument();
  });
});
