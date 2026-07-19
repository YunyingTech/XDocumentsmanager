import { create } from 'zustand';

type ViewType = 'files' | 'search' | 'folders' | 'settings' | 'ocr';

interface UIStore {
  activeView: ViewType;
  sidebarOpen: boolean;
  theme: 'light' | 'dark' | 'system';

  setView: (view: ViewType) => void;
  toggleSidebar: () => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
}

export const useUIStore = create<UIStore>((set) => ({
  activeView: 'files',
  sidebarOpen: true,
  theme: 'system',

  setView: (view) => set({ activeView: view }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setTheme: (theme) => set({ theme }),
}));
