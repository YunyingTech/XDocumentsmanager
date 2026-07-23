import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const state = vi.hoisted(() => ({
  folder: {
    selectedFolderId: 3,
    folders: [{
      id: 3,
      path: 'C:\\Docs\\',
      display_name: 'Docs',
      folder_type: 'local',
      last_scan_status: 'completed',
      total_files: 1,
    }],
  },
  file: {
    files: [{ id: 9, relative_path: 'sub\\report.pdf', file_name: 'report.pdf' }],
    isLoading: false,
    selectedFileId: 9,
    loadFiles: vi.fn(),
    selectFile: vi.fn(),
  },
}));

vi.mock('../../stores/folderStore', () => ({
  useFolderStore: (selector: (value: unknown) => unknown) => selector(state.folder),
}));
vi.mock('../../stores/fileStore', () => ({
  useFileStore: (selector: (value: unknown) => unknown) => selector(state.file),
}));
vi.mock('./Toolbar', () => ({ Toolbar: () => <div>Toolbar</div> }));
vi.mock('./FileTable', () => ({ FileTable: () => <div>File table</div> }));
vi.mock('../viewer/PdfViewer', () => ({
  PdfViewer: ({ filePath, fileName, onClose }: { filePath: string; fileName: string; onClose: () => void }) => (
    <div data-testid="file-preview">
      <span>{fileName}</span>
      <span>{filePath}</span>
      <button type="button" onClick={onClose}>Close file preview</button>
    </div>
  ),
}));

import { FileBrowser } from './FileBrowser';

describe('file browser preview workflow', () => {
  beforeEach(() => {
    state.file.loadFiles.mockReset();
    state.file.selectFile.mockReset();
  });

  it('previews the selected PDF with its absolute Windows path', async () => {
    const user = userEvent.setup();
    render(<FileBrowser />);

    expect(screen.getByTestId('file-preview')).toHaveTextContent('C:\\Docs\\sub\\report.pdf');
    await user.click(screen.getByRole('button', { name: 'Close file preview' }));
    expect(state.file.selectFile).toHaveBeenCalledWith(null);
  });
});
