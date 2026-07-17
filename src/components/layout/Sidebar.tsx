import {
  FolderOpen, Search, Settings, Plus, ChevronLeft,
  HardDrive, Network, Circle
} from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { useFolderStore } from '../../stores/folderStore';
import { useSearchStore } from '../../stores/searchStore';

export function Sidebar() {
  const activeView = useUIStore((s) => s.activeView);
  const setView = useUIStore((s) => s.setView);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const folders = useFolderStore((s) => s.folders);
  const selectedFolderId = useFolderStore((s) => s.selectedFolderId);
  const selectFolder = useFolderStore((s) => s.selectFolder);
  const indexProgress = useFolderStore((s) => s.indexProgress);
  const toggleSearch = useSearchStore((s) => s.toggleOpen);

  return (
    <aside className="w-64 flex flex-col border-r border-surface-200 bg-white dark:bg-surface-950 dark:border-surface-800 select-none">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-14 drag-region">
        <div className="w-8 h-8 rounded-lg bg-accent-500 flex items-center justify-center">
          <FolderOpen size={18} className="text-white" />
        </div>
        <span className="font-semibold text-sm text-surface-900 dark:text-surface-100">
          XDocuments
        </span>
        <button
          onClick={toggleSidebar}
          className="ml-auto btn-ghost p-1.5 rounded-lg no-drag"
          title="Collapse sidebar"
        >
          <ChevronLeft size={16} />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col gap-1 px-3 py-2">
        <button
          onClick={() => { setView('files'); toggleSearch(); }}
          className={`sidebar-item ${activeView === 'files' ? 'active' : ''}`}
        >
          <FolderOpen size={18} />
          Files
        </button>
        <button
          onClick={() => setView('search')}
          className={`sidebar-item ${activeView === 'search' ? 'active' : ''}`}
        >
          <Search size={18} />
          Search
        </button>
        <button
          onClick={() => setView('folders')}
          className={`sidebar-item ${activeView === 'folders' ? 'active' : ''}`}
        >
          <HardDrive size={18} />
          Folders
        </button>
        <button
          onClick={() => setView('settings')}
          className={`sidebar-item ${activeView === 'settings' ? 'active' : ''}`}
        >
          <Settings size={18} />
          Settings
        </button>
      </nav>

      {/* Divider */}
      <div className="mx-4 my-2 border-t border-surface-200 dark:border-surface-800" />

      {/* Folders List */}
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-xs font-semibold text-surface-400 uppercase tracking-wider">
          Indexed Folders
        </span>
        <button
          onClick={() => setView('folders')}
          className="p-1 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-800 text-surface-400 hover:text-surface-700"
          title="Add folder"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-2 space-y-0.5">
        {folders.map((folder) => (
          <button
            key={folder.id}
            onClick={() => {
              selectFolder(folder.id);
              setView('files');
            }}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-colors
              ${selectedFolderId === folder.id
                ? 'bg-surface-200 dark:bg-surface-800 text-surface-900 dark:text-surface-100'
                : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-900'
              }`}
          >
            {folder.folder_type === 'smb' ? (
              <Network size={14} className="shrink-0" />
            ) : (
              <HardDrive size={14} className="shrink-0" />
            )}
            <span className="truncate text-left">
              {folder.display_name || folder.path.split('\\').pop() || folder.path}
            </span>
            {indexProgress?.folder_id === folder.id && (
              <Circle size={8} className="shrink-0 text-accent-500 fill-accent-500 animate-pulse" />
            )}
          </button>
        ))}

        {folders.length === 0 && (
          <p className="text-xs text-surface-400 text-center py-4">
            No folders indexed yet
          </p>
        )}
      </div>

      {/* Bottom */}
      <div className="px-4 py-3 border-t border-surface-200 dark:border-surface-800">
        <p className="text-xs text-surface-400">
          {folders.length} folder{folders.length !== 1 ? 's' : ''} indexed
        </p>
      </div>
    </aside>
  );
}
