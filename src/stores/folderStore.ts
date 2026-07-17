import { create } from 'zustand';
import type { FolderInfo, IndexProgress } from '../types';
import { listFolders } from '../lib/tauri';

interface FolderStore {
  folders: FolderInfo[];
  selectedFolderId: number | null;
  indexProgress: IndexProgress | null;
  isLoading: boolean;

  selectFolder: (id: number | null) => void;
  loadFolders: () => Promise<void>;
  setIndexProgress: (progress: IndexProgress | null) => void;
}

export const useFolderStore = create<FolderStore>((set) => ({
  folders: [],
  selectedFolderId: null,
  indexProgress: null,
  isLoading: false,

  selectFolder: (id) => set({ selectedFolderId: id }),

  loadFolders: async () => {
    set({ isLoading: true });
    try {
      const folders = await listFolders();
      set({ folders, isLoading: false });
      // Auto-select first folder if none selected
      const { selectedFolderId } = useFolderStore.getState();
      if (!selectedFolderId && folders.length > 0) {
        set({ selectedFolderId: folders[0].id });
      }
    } catch (err) {
      console.error('Failed to load folders:', err);
      set({ isLoading: false });
    }
  },

  setIndexProgress: (progress) => set({ indexProgress: progress }),
}));
