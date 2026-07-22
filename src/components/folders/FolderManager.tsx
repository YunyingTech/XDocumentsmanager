import { useState } from 'react';
import { useFolderStore } from '../../stores/folderStore';
import { AddFolderDialog } from './AddFolderDialog';
import { FolderList } from './FolderList';
import { EmptyState } from '../common/EmptyState';
import { Plus } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

export function FolderManager() {
  const { t } = useI18n();
  const folders = useFolderStore((s) => s.folders);
  const loadFolders = useFolderStore((s) => s.loadFolders);
  const [showAddDialog, setShowAddDialog] = useState(false);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950">
        <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
          {t('folders.management')}
        </h2>
        <button
          onClick={() => setShowAddDialog(true)}
          className="btn-primary text-xs py-1.5"
        >
          <Plus size={14} />
          {t('folders.add')}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {folders.length === 0 ? (
          <EmptyState
            icon={Plus}
            title={t('folders.noneAdded')}
            description={t('folders.noneAddedHint')}
            action={{ label: t('folders.add'), onClick: () => setShowAddDialog(true) }}
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
