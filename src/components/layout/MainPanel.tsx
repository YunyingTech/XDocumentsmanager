import { useUIStore } from '../../stores/uiStore';
import { FileBrowser } from '../file-browser/FileBrowser';
import { SearchView } from '../search/SearchView';
import { FolderManager } from '../folders/FolderManager';
import { SettingsPanel } from '../settings/SettingsPanel';
import { OcrPage } from '../ocr/OcrPage';

export function MainPanel() {
  const activeView = useUIStore((s) => s.activeView);

  return (
    <main className="flex-1 overflow-hidden">
      {activeView === 'files' && <FileBrowser />}
      {activeView === 'search' && <SearchView />}
      {activeView === 'folders' && <FolderManager />}
      {activeView === 'ocr' && <OcrPage />}
      {activeView === 'settings' && <SettingsPanel />}
    </main>
  );
}
