import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Sidebar } from './components/layout/Sidebar';
import { MainPanel } from './components/layout/MainPanel';
import { StatusBar } from './components/layout/StatusBar';
import { useFolderStore } from './stores/folderStore';
import { useUIStore } from './stores/uiStore';
import type { IndexProgress } from './types';

export default function App() {
  const loadFolders = useFolderStore((s) => s.loadFolders);
  const setIndexProgress = useFolderStore((s) => s.setIndexProgress);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const theme = useUIStore((s) => s.theme);
  const language = useUIStore((s) => s.language);

  useEffect(() => {
    loadFolders();

    // Listen for indexing progress events from Rust backend
    const unlisten = listen<IndexProgress>('indexing:progress', (event) => {
      setIndexProgress(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
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
    <div className="flex h-screen w-screen bg-surface-50 dark:bg-surface-950 overflow-hidden">
      {sidebarOpen && <Sidebar />}
      <div className="flex flex-col flex-1 min-w-0">
        <MainPanel />
        <StatusBar />
      </div>
    </div>
  );
}
