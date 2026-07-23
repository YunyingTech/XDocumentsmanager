import { useUIStore } from '../../stores/uiStore';
import { FileBrowser } from '../file-browser/FileBrowser';
import { SearchView } from '../search/SearchView';
import { FolderManager } from '../folders/FolderManager';
import { SettingsPanel } from '../settings/SettingsPanel';
import { OcrPage } from '../ocr/OcrPage';
import { RuntimeLogs } from '../logs/RuntimeLogs';
import { ViewToolbar } from './ViewToolbar';

export function MainPanel() {
  const activeView = useUIStore((s) => s.activeView);
  const surfaceView = useUIStore((s) => s.surfaceView);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewToolbar />
      <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 overflow-hidden">
        {surfaceView === 'logs' ? <RuntimeLogs /> : (
          <>
            {activeView === 'files' && <FileBrowser />}
            {activeView === 'search' && <SearchView />}
            {activeView === 'folders' && <FolderManager />}
            {activeView === 'ocr' && <OcrPage />}
            {activeView === 'settings' && <SettingsPanel />}
          </>
        )}
      </main>
    </div>
  );
}
