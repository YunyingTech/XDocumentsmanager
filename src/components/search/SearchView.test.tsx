import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fileFixture, searchResultFixture } from '../../test/fixtures';

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
import { SearchView } from './SearchView';

describe('search result workflow', () => {
  beforeEach(() => {
    Object.values(tauri).forEach((mock) => mock.mockReset());
    useUIStore.setState({ language: 'en' });
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
    });
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
      match_model: 'gpt-test',
    };
    useSearchStore.setState({ results: [result] });
    const user = userEvent.setup();
    render(<SearchView />);

    expect(screen.getByText('gpt-test')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open containing folder' }));

    expect(tauri.showInFolder).toHaveBeenCalledWith(result.absolute_path);
    expect(useSearchStore.getState().selectedResultId).toBeNull();
  });
});
