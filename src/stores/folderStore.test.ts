import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexProgress } from '../types';
import { folderFixture } from '../test/fixtures';

const listFolders = vi.hoisted(() => vi.fn());
vi.mock('../lib/tauri', () => ({ listFolders }));

import { useFolderStore } from './folderStore';

describe('folder store', () => {
  beforeEach(() => {
    listFolders.mockReset();
    useFolderStore.setState({
      folders: [],
      selectedFolderId: null,
      indexProgressByJob: {},
      isLoading: false,
    });
  });

  afterEach(() => vi.useRealTimers());

  it('loads folders and selects the first one only when no folder is selected', async () => {
    const folders = [folderFixture({ id: 1 }), folderFixture({ id: 2 })];
    listFolders.mockResolvedValue(folders);
    await useFolderStore.getState().loadFolders();
    expect(useFolderStore.getState()).toMatchObject({ folders, selectedFolderId: 1, isLoading: false });

    useFolderStore.setState({ selectedFolderId: 2 });
    await useFolderStore.getState().loadFolders();
    expect(useFolderStore.getState().selectedFolderId).toBe(2);
  });

  it('clears loading state when folder loading fails', async () => {
    listFolders.mockRejectedValue(new Error('database unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await useFolderStore.getState().loadFolders();
    expect(useFolderStore.getState().isLoading).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('refreshes folder totals and clears completed index progress after the display delay', async () => {
    vi.useFakeTimers();
    listFolders.mockResolvedValue([folderFixture({ id: 1, total_files: 12 })]);
    useFolderStore.getState().setIndexProgress({
      job_id: 8,
      folder_id: 1,
      index_mode: 'incremental',
      status: 'completed',
      ocr_after_index: true,
      files_total: 12,
      files_processed: 12,
      files_indexed: 12,
      files_skipped: 0,
      files_errors: 0,
      bytes_processed: 100,
      current_file: null,
      phase: 'completed',
      files_discovered: 12,
      elapsed_ms: 1000,
      estimated_remaining_ms: 0,
      files_per_second: 12,
      bytes_per_second: 100,
    });

    expect(listFolders).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(listFolders).toHaveBeenCalledOnce();
    expect(useFolderStore.getState().indexProgressByJob[8]?.status).toBe('completed');
    await vi.advanceTimersByTimeAsync(500);
    expect(useFolderStore.getState().indexProgressByJob).toEqual({});
  });
});

function progress(job: number, folder: number, status = 'running'): IndexProgress {
  return { job_id: job, folder_id: folder, status, index_mode: 'incremental',
    ocr_after_index: false, files_total: 10, files_processed: 4, files_indexed: 4,
    files_skipped: 0, files_errors: 0, bytes_processed: 100, current_file: 'four.pdf',
    phase: status === 'completed' ? 'completed' : status === 'error' ? 'failed' : 'processing',
    files_discovered: 10, elapsed_ms: 1000, estimated_remaining_ms: 1500,
    files_per_second: 4, bytes_per_second: 100 };
}

describe('concurrent index progress regression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    listFolders.mockReset().mockResolvedValue([]);
    useFolderStore.getState().setIndexProgress(null);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    useFolderStore.getState().setIndexProgress(null);
  });

  it('retains interleaved progress for every folder', () => {
    const a = progress(1, 10);
    const b = progress(2, 20);
    useFolderStore.getState().setIndexProgress(a);
    useFolderStore.getState().setIndexProgress(b);
    const updated = { ...a, files_processed: 8 };
    useFolderStore.getState().setIndexProgress(updated);
    expect(useFolderStore.getState()).toMatchObject({ indexProgressByJob: { 1: updated, 2: b } });
  });

  it.each(['completed', 'error'])('clears only the %s job while another folder runs', async (status) => {
    useFolderStore.getState().setIndexProgress(progress(1, 10, status));
    const running = progress(2, 20);
    useFolderStore.getState().setIndexProgress(running);
    await vi.advanceTimersByTimeAsync(2500);
    expect(useFolderStore.getState()).toHaveProperty('indexProgressByJob', { 2: running });
  });

  it('keeps a restarted job for the same folder after the old job expires', async () => {
    useFolderStore.getState().setIndexProgress(progress(1, 10, 'completed'));
    await vi.advanceTimersByTimeAsync(2000);
    const running = progress(2, 10);
    useFolderStore.getState().setIndexProgress(running);
    await vi.advanceTimersByTimeAsync(500);
    expect(useFolderStore.getState()).toHaveProperty('indexProgressByJob', { 2: running });
  });

  it('does not let an old timer clear a newer update of the same job', async () => {
    useFolderStore.getState().setIndexProgress(progress(1, 10, 'completed'));
    await vi.advanceTimersByTimeAsync(2000);
    const updated = progress(1, 10);
    useFolderStore.getState().setIndexProgress(updated);
    await vi.advanceTimersByTimeAsync(500);
    expect(useFolderStore.getState()).toHaveProperty('indexProgressByJob', { 1: updated });
  });

  it('waits for refreshed totals before removing the completed progress', async () => {
    let resolve!: (folders: ReturnType<typeof folderFixture>[]) => void;
    listFolders.mockReturnValue(new Promise((done) => { resolve = done; }));
    const completed = progress(1, 10, 'completed');
    useFolderStore.getState().setIndexProgress(completed);
    await vi.advanceTimersByTimeAsync(4000);
    expect(useFolderStore.getState()).toHaveProperty('indexProgressByJob', { 1: completed });
    resolve([folderFixture({ id: 10, total_files: 10 })]);
    await vi.advanceTimersByTimeAsync(500);
    expect(useFolderStore.getState()).toHaveProperty('indexProgressByJob', {});
    expect(useFolderStore.getState().folders[0].total_files).toBe(10);
  });
});
