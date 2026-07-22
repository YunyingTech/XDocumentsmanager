import { create } from 'zustand';

type ViewType = 'files' | 'search' | 'folders' | 'settings' | 'ocr';
export type Language = 'en' | 'zh-CN';

interface UIStore {
  activeView: ViewType;
  sidebarOpen: boolean;
  theme: 'light' | 'dark' | 'system';
  language: Language;

  setView: (view: ViewType) => void;
  toggleSidebar: () => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setLanguage: (language: Language) => void;
}

function initialLanguage(): Language {
  const saved = localStorage.getItem('xdocuments-language');
  if (saved === 'en' || saved === 'zh-CN') return saved;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export const useUIStore = create<UIStore>((set) => ({
  activeView: 'files',
  sidebarOpen: true,
  theme: 'system',
  language: initialLanguage(),

  setView: (view) => set({ activeView: view }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setTheme: (theme) => set({ theme }),
  setLanguage: (language) => {
    localStorage.setItem('xdocuments-language', language);
    set({ language });
  },
}));
