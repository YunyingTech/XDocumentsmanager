import { create } from 'zustand';
import type { FolderInfo, IndexProgress } from '../types';
import { listFolders } from '../lib/tauri';

interface FolderStore {
  folders: FolderInfo[];
  selectedFolderId: number | null;
  indexProgressByJob: Record<number, IndexProgress>;
  isLoading: boolean;

  selectFolder: (id: number | null) => void;
  loadFolders: () => Promise<void>;
  setIndexProgress: (progress: IndexProgress | null) => void;
}

export const useFolderStore = create<FolderStore>((set) => ({
  folders: [],
  selectedFolderId: null,
  indexProgressByJob: {},
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

  setIndexProgress: (progress) => {
    if (!progress) {
      set({ indexProgressByJob: {} });
      return;
    }
    set((state) => ({
      indexProgressByJob: { ...state.indexProgressByJob, [progress.job_id]: progress },
    }));
    if (progress.status === 'completed' || progress.status === 'error') {
      // Each completion owns only its own snapshot, never another running job.
      setTimeout(async () => {
        await useFolderStore.getState().loadFolders();
        setTimeout(() => {
          set((state) => {
            if (state.indexProgressByJob[progress.job_id] !== progress) return state;
            const remaining = { ...state.indexProgressByJob };
            delete remaining[progress.job_id];
            return { indexProgressByJob: remaining };
          });
        }, 500);
      }, 2000);
    }
  },
}));
