import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      indexProgress: null,
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
      status: 'completed',
      ocr_after_index: true,
      files_total: 12,
      files_processed: 12,
      files_indexed: 12,
      files_skipped: 0,
      files_errors: 0,
      bytes_processed: 100,
      current_file: null,
    });

    expect(listFolders).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(listFolders).toHaveBeenCalledOnce();
    expect(useFolderStore.getState().indexProgress?.status).toBe('completed');
    await vi.advanceTimersByTimeAsync(500);
    expect(useFolderStore.getState().indexProgress).toBeNull();
  });
});
