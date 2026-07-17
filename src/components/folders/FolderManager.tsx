import { useState } from 'react';
import { useFolderStore } from '../../stores/folderStore';
import { AddFolderDialog } from './AddFolderDialog';
import { FolderList } from './FolderList';
import { EmptyState } from '../common/EmptyState';
import { Plus } from 'lucide-react';

export function FolderManager() {
  const folders = useFolderStore((s) => s.folders);
  const loadFolders = useFolderStore((s) => s.loadFolders);
  const [showAddDialog, setShowAddDialog] = useState(false);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950">
        <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
          Folder Management
        </h2>
        <button
          onClick={() => setShowAddDialog(true)}
          className="btn-primary text-xs py-1.5"
        >
          <Plus size={14} />
          Add Folder
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {folders.length === 0 ? (
          <EmptyState
            icon={Plus}
            title="No folders added"
            description="Add a local folder or SMB network share path to start indexing PDF files."
            action={{ label: 'Add Folder', onClick: () => setShowAddDialog(true) }}
          />
        ) : (
          <FolderList onAddFolder={() => setShowAddDialog(true)} />
        )}
      </div>

      {showAddDialog && (
        <AddFolderDialog
          onClose={() => setShowAddDialog(false)}
          onAdded={() => {
            setShowAddDialog(false);
            loadFolders();
          }}
        />
      )}
    </div>
  );
}
