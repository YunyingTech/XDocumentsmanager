import { create } from 'zustand';
import type { FileInfo, SortConfig, PaginatedResult } from '../types';
import { listFiles } from '../lib/tauri';

interface FileStore {
  files: FileInfo[];
  total: number;
  page: number;
  pageSize: number;
  sort: SortConfig;
  isLoading: boolean;
  selectedFileId: number | null;

  setSort: (sort: SortConfig) => void;
  selectFile: (id: number | null) => void;
  loadFiles: (folderId: number) => Promise<void>;
  setPage: (page: number) => void;
}

export const useFileStore = create<FileStore>((set, get) => ({
  files: [],
  total: 0,
  page: 0,
  pageSize: 50,
  sort: { field: 'file_modified_at', direction: 'desc' },
  isLoading: false,
  selectedFileId: null,

  setSort: (sort: SortConfig) => set({ sort }),

  selectFile: (id) => set({ selectedFileId: id }),

  loadFiles: async (folderId: number) => {
    set({ isLoading: true });
    try {
      const { sort, page, pageSize } = get();
      const result: PaginatedResult<FileInfo> = await listFiles(folderId, sort, page, pageSize);
      set({ files: result.items, total: result.total, isLoading: false });
    } catch (err) {
      console.error('Failed to load files:', err);
      set({ isLoading: false });
    }
  },

  setPage: (page: number) => set({ page }),
}));
