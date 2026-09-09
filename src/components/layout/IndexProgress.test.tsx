import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { folderFixture } from '../../test/fixtures';
import type { IndexProgress } from '../../types';

vi.mock('../../lib/tauri', () => ({ listFolders: vi.fn().mockResolvedValue([]), removeFolder: vi.fn(), startIndexing: vi.fn() }));
vi.mock('../../stores/ocrStore', () => ({
  useOcrStore: (select: (state: unknown) => unknown) => select({
    tasks: [], bulkOcrRunning: false, bulkOcrQueued: 0,
    clearTasks: vi.fn(), downloadResult: vi.fn(), cancelTask: vi.fn(), cancelAllTasks: vi.fn(),
  }),
}));

import { useFolderStore } from '../../stores/folderStore';
import { useUIStore } from '../../stores/uiStore';
import { Sidebar } from './Sidebar';
import { TaskCenter } from './TaskCenter';
import { FolderList } from '../folders/FolderList';

function progress(job: number, folder: number, status = 'running'): IndexProgress {
  return { job_id: job, folder_id: folder, status, index_mode: 'incremental',
    ocr_after_index: false, files_total: 10, files_processed: job, files_indexed: job,
    files_skipped: 0, files_errors: 0, bytes_processed: 100, current_file: `${job}.pdf`,
    phase: status === 'completed' ? 'completed' : status === 'error' ? 'failed' : 'processing',
    files_discovered: 10, elapsed_ms: 1000, estimated_remaining_ms: 2000,
    files_per_second: 2, bytes_per_second: 100 };
}

describe('multi-folder index display', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUIStore.setState({ language: 'en' });
    useFolderStore.setState({ indexProgressByJob: {}, selectedFolderId: null, folders: [
      folderFixture({ id: 10, display_name: 'Alpha' }),
      folderFixture({ id: 20, display_name: 'Beta' }),
    ] });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('shows every active folder and keeps the other task visible when one completes', async () => {
    useFolderStore.getState().setIndexProgress(progress(1, 10));
    useFolderStore.getState().setIndexProgress(progress(2, 20, 'queued'));
    render(<><Sidebar /><TaskCenter /></>);
    expect(screen.getByText('2 tasks running')).toBeInTheDocument();
    for (const name of ['Alpha', 'Beta']) {
      expect(screen.getByRole('button', { name }).querySelector('.animate-pulse')).not.toBeNull();
    }
    fireEvent.click(screen.getByTitle('Open task center'));
    const center = screen.getByRole('region', { name: 'Task center' });
    expect(within(center).getByText('Alpha')).toBeInTheDocument();
    expect(within(center).getByText('Beta')).toBeInTheDocument();
    expect(within(center).getByText('10%')).toBeInTheDocument();
    expect(within(center).getByText('20%')).toBeInTheDocument();
    act(() => useFolderStore.getState().setIndexProgress(progress(1, 10, 'completed')));
    expect(screen.getByText('1 task running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alpha' }).querySelector('.animate-pulse')).toBeNull();
    expect(screen.getByRole('button', { name: 'Beta' }).querySelector('.animate-pulse')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(within(center).queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('1 task running')).toBeInTheDocument();
    expect(within(center).getByText('20%')).toBeInTheDocument();
  });

  it('counts independent errors rather than only the last received event', () => {
    useFolderStore.getState().setIndexProgress(progress(1, 10, 'error'));
    useFolderStore.getState().setIndexProgress(progress(2, 20, 'error'));
    render(<TaskCenter />);
    expect(screen.getByText('2 tasks need attention')).toBeInTheDocument();
  });

  it('updates folder badges from their own latest job, including a restart', () => {
    useFolderStore.getState().setIndexProgress(progress(1, 10, 'completed'));
    useFolderStore.getState().setIndexProgress(progress(2, 20, 'error'));
    useFolderStore.getState().setIndexProgress(progress(3, 10));
    render(<FolderList onAddFolder={() => undefined} />);
    const alpha = screen.getByText('Alpha').closest('.card') as HTMLElement;
    const beta = screen.getByText('Beta').closest('.card') as HTMLElement;
    expect(within(alpha).getByText('Indexing')).toBeInTheDocument();
    expect(within(beta).getByText('Error')).toBeInTheDocument();
    act(() => useFolderStore.getState().setIndexProgress(progress(3, 10, 'completed')));
    expect(within(alpha).getByText('Indexed')).toBeInTheDocument();
    expect(within(beta).getByText('Error')).toBeInTheDocument();
  });
});
