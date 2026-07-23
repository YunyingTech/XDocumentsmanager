import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Sidebar } from './components/layout/Sidebar';
import { MainPanel } from './components/layout/MainPanel';
import { StatusBar } from './components/layout/StatusBar';
import { useFolderStore } from './stores/folderStore';
import { useUIStore } from './stores/uiStore';
import { useSearchStore } from './stores/searchStore';
import { useOcrStore } from './stores/ocrStore';
import type { IndexProgress, SearchProgress, WindowsOcrProgress } from './types';

export default function App() {
  const loadFolders = useFolderStore((s) => s.loadFolders);
  const setIndexProgress = useFolderStore((s) => s.setIndexProgress);
  const updateSearchProgress = useSearchStore((s) => s.updateProgress);
  const updateWindowsOcrProgress = useOcrStore((s) => s.updateWindowsProgress);
  const queueFolderOcr = useOcrStore((s) => s.queueFolderOcr);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const theme = useUIStore((s) => s.theme);
  const language = useUIStore((s) => s.language);

  useEffect(() => {
    loadFolders();

    // Listen for indexing progress events from Rust backend
    const unlisten = listen<IndexProgress>('indexing:progress', (event) => {
      setIndexProgress(event.payload);
      if (
        event.payload.status === 'completed' &&
        event.payload.ocr_after_index &&
        event.payload.folder_id !== null
      ) {
        void queueFolderOcr(event.payload.folder_id).catch((error) => {
          console.error('Failed to queue OCR after indexing:', error);
        });
      }
    });
    const unlistenSearch = listen<SearchProgress>('search:progress', (event) => {
      updateSearchProgress(event.payload);
    });
    const unlistenOcr = listen<WindowsOcrProgress>('ocr:progress', (event) => {
      updateWindowsOcrProgress(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
      unlistenSearch.then((fn) => fn());
      unlistenOcr.then((fn) => fn());
    };
  }, [loadFolders, queueFolderOcr, setIndexProgress, updateSearchProgress, updateWindowsOcrProgress]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f0f0f' : '#fafafa');
    };

    applyTheme();
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === 'zh-CN' ? 'XDocuments 文档管理器' : 'XDocuments Manager';
  }, [language]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-50 dark:bg-surface-950">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-md bg-white px-3 py-2 text-sm font-medium text-surface-900 shadow-lg transition-transform focus:translate-y-0 dark:bg-surface-800 dark:text-surface-100"
      >
        {language === 'zh-CN' ? '跳转到主要内容' : 'Skip to main content'}
      </a>
      <h1 className="sr-only">XDocuments Manager</h1>
      {sidebarOpen && <Sidebar />}
      <div className="flex flex-col flex-1 min-w-0">
        <MainPanel />
        <StatusBar />
      </div>
    </div>
  );
}
