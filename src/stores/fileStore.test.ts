import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileInfo, PaginatedResult } from '../types';
import { fileFixture } from '../test/fixtures';

const listFiles = vi.hoisted(() => vi.fn());
vi.mock('../lib/tauri', () => ({ listFiles }));

import { useFileStore } from './fileStore';

function page(items: FileInfo[]): PaginatedResult<FileInfo> {
  return { items, total: items.length, page: 0, page_size: 50, total_pages: items.length ? 1 : 0 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('file store', () => {
  beforeEach(() => {
    listFiles.mockReset();
    useFileStore.setState({
      files: [],
      total: 0,
      page: 0,
      pageSize: 50,
      sort: { field: 'file_modified_at', direction: 'desc' },
      isLoading: false,
      selectedFileId: null,
    });
  });

  it('loads a page using the current sort and pagination', async () => {
    const file = fileFixture({ id: 5 });
    listFiles.mockResolvedValue(page([file]));

    await useFileStore.getState().loadFiles(10);

    expect(listFiles).toHaveBeenCalledWith(
      10,
      { field: 'file_modified_at', direction: 'desc' },
      0,
      50,
    );
    expect(useFileStore.getState()).toMatchObject({ files: [file], total: 1, isLoading: false });
  });

  it('does not let a slow stale request overwrite a newer folder', async () => {
    const first = deferred<PaginatedResult<FileInfo>>();
    const second = deferred<PaginatedResult<FileInfo>>();
    listFiles.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstLoad = useFileStore.getState().loadFiles(1);
    const secondLoad = useFileStore.getState().loadFiles(2);
    second.resolve(page([fileFixture({ id: 2, file_name: 'new.pdf' })]));
    await secondLoad;
    first.resolve(page([fileFixture({ id: 1, file_name: 'stale.pdf' })]));
    await firstLoad;

    expect(useFileStore.getState().files.map((file) => file.file_name)).toEqual(['new.pdf']);
    expect(useFileStore.getState().isLoading).toBe(false);
  });

  it('resets page and selection before reloading with a new sort', async () => {
    listFiles.mockResolvedValue(page([]));
    useFileStore.setState({ page: 4, selectedFileId: 9 });

    await useFileStore.getState().setSort({ field: 'file_name', direction: 'asc' }, 10);

    expect(useFileStore.getState()).toMatchObject({
      page: 0,
      selectedFileId: null,
      sort: { field: 'file_name', direction: 'asc' },
    });
    expect(listFiles).toHaveBeenCalledWith(10, { field: 'file_name', direction: 'asc' }, 0, 50);
  });
});
