import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const state = vi.hoisted(() => ({
  folder: {
    selectedFolderId: 7,
    folders: [{ id: 7, display_name: 'Archive', path: 'C:\\Archive', total_files: 12 }],
  },
  file: {
    sort: { field: 'file_modified_at', direction: 'desc' },
    setSort: vi.fn(),
    loadFiles: vi.fn(),
    selectFile: vi.fn(),
  },
  search: { toggleOpen: vi.fn() },
  ui: { language: 'en', setView: vi.fn() },
  startIndexing: vi.fn(),
}));

vi.mock('../../stores/folderStore', () => ({
  useFolderStore: (selector: (value: unknown) => unknown) => selector(state.folder),
}));
vi.mock('../../stores/fileStore', () => ({
  useFileStore: (selector: (value: unknown) => unknown) => selector(state.file),
}));
vi.mock('../../stores/searchStore', () => ({
  useSearchStore: (selector: (value: unknown) => unknown) => selector(state.search),
}));
vi.mock('../../stores/uiStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../stores/uiStore')>();
  return {
    ...original,
    useUIStore: Object.assign(
      (selector: (value: unknown) => unknown) => selector(state.ui),
      original.useUIStore,
    ),
  };
});
vi.mock('../../lib/tauri', () => ({
  startIndexing: state.startIndexing,
}));

import { Toolbar } from './Toolbar';

describe('file toolbar indexing modes', () => {
  beforeEach(() => {
    state.startIndexing.mockReset().mockResolvedValue(1);
    state.file.loadFiles.mockReset();
    state.file.setSort.mockReset();
    state.file.selectFile.mockReset();
  });

  it('uses incremental mode for normal indexing and index plus OCR', async () => {
    const user = userEvent.setup();
    render(<Toolbar />);

    await user.click(screen.getByRole('button', { name: 'Incremental index' }));
    await user.click(screen.getByRole('button', { name: 'Incremental index and OCR' }));

    expect(state.startIndexing.mock.calls).toEqual([[7], [7, true]]);
  });

  it('requires confirmation before starting a full re-index', async () => {
    const user = userEvent.setup();
    render(<Toolbar />);

    await user.click(screen.getByRole('button', { name: 'Full re-index' }));
    expect(screen.getByText('Full re-index this folder?')).toBeInTheDocument();
    expect(state.startIndexing).not.toHaveBeenCalled();

    const fullButtons = screen.getAllByRole('button', { name: 'Full re-index' });
    await user.click(fullButtons[fullButtons.length - 1]);
    expect(state.startIndexing).toHaveBeenCalledWith(7, false, 'full');
  });
});
