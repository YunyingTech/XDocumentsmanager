import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const state = vi.hoisted(() => ({
  cancelAllTasks: vi.fn(),
  cancelTask: vi.fn(),
  clearTasks: vi.fn(),
  downloadResult: vi.fn(),
  tasks: [] as Array<Record<string, unknown>>,
  folders: [] as Array<Record<string, unknown>>,
  indexProgress: null as Record<string, unknown> | null,
}));

vi.mock('../../stores/ocrStore', () => ({
  useOcrStore: (selector: (value: unknown) => unknown) => selector(state),
}));
vi.mock('../../stores/folderStore', () => ({
  useFolderStore: (selector: (value: unknown) => unknown) => selector(state),
}));

import { useUIStore } from '../../stores/uiStore';
import { TaskCenter } from './TaskCenter';

describe('task center', () => {
  beforeEach(() => {
    state.cancelAllTasks.mockReset();
    state.cancelTask.mockReset();
    state.clearTasks.mockReset();
    state.downloadResult.mockReset();
    state.tasks = [];
    state.folders = [];
    state.indexProgress = null;
    useUIStore.setState({ language: 'en' });
  });

  it('offers one-click cancellation when OCR tasks are active', async () => {
    state.tasks = [{
      taskId: 'task-1',
      fileId: 1,
      fileName: 'scan.pdf',
      status: 'running',
      queuedAhead: null,
      progress: 25,
      submittedAt: 1,
      engine: 'windows',
    }];
    const user = userEvent.setup();
    render(<TaskCenter />);

    await user.click(screen.getByTitle('Open task center'));
    await user.click(screen.getByRole('button', { name: 'Cancel all OCR tasks' }));

    expect(state.cancelAllTasks).toHaveBeenCalledOnce();
    expect(screen.getByText('scan.pdf')).toBeInTheDocument();
  });

  it('shows that an index task will continue with OCR', async () => {
    state.folders = [{ id: 3, display_name: 'Archive' }];
    state.indexProgress = {
      job_id: 4,
      folder_id: 3,
      index_mode: 'incremental',
      status: 'running',
      ocr_after_index: true,
      files_total: 10,
      files_processed: 4,
      files_indexed: 4,
      files_skipped: 0,
      files_errors: 0,
      bytes_processed: 100,
      current_file: 'four.pdf',
    };
    const user = userEvent.setup();
    render(<TaskCenter />);

    await user.click(screen.getByTitle('Open task center'));
    expect(screen.getByText('Incremental indexing')).toBeInTheDocument();
    expect(screen.getByText('Archive / OCR after indexing')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  it('labels explicit full re-index jobs separately', async () => {
    state.folders = [{ id: 3, display_name: 'Archive' }];
    state.indexProgress = {
      job_id: 5,
      folder_id: 3,
      index_mode: 'full',
      status: 'running',
      ocr_after_index: false,
      files_total: 10,
      files_processed: 1,
      files_indexed: 1,
      files_skipped: 0,
      files_errors: 0,
      bytes_processed: 100,
      current_file: 'one.pdf',
    };
    const user = userEvent.setup();
    render(<TaskCenter />);

    await user.click(screen.getByTitle('Open task center'));
    expect(screen.getByText('Full re-indexing')).toBeInTheDocument();
  });
});
