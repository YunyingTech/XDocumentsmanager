import { useEffect } from 'react';
import { useFolderStore } from '../../stores/folderStore';
import { useFileStore } from '../../stores/fileStore';
import { FileTable } from './FileTable';
import { Toolbar } from './Toolbar';
import { EmptyState } from '../common/EmptyState';
import { LoadingOverlay } from '../common/LoadingOverlay';
import { Plus } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { useI18n } from '../../lib/i18n';

export function FileBrowser() {
  const { t } = useI18n();
  const selectedFolderId = useFolderStore((s) => s.selectedFolderId);
  const folders = useFolderStore((s) => s.folders);
  const files = useFileStore((s) => s.files);
  const isLoading = useFileStore((s) => s.isLoading);
  const loadFiles = useFileStore((s) => s.loadFiles);
  const setView = useUIStore((s) => s.setView);

  const selectedFolder = folders.find((f) => f.id === selectedFolderId);

  useEffect(() => {
    if (selectedFolderId !== null) {
      loadFiles(selectedFolderId);
    }
  }, [selectedFolderId]);

  if (folders.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <Toolbar />
        <div className="flex-1">
          <EmptyState
            icon={Plus}
            title={t('files.noFolders')}
            description={t('files.noFoldersHint')}
            action={{ label: t('folders.add'), onClick: () => setView('folders') }}
          />
        </div>
      </div>
    );
  }

  if (!selectedFolder) {
    return (
      <div className="flex flex-col h-full">
        <Toolbar />
        <div className="flex-1">
          <EmptyState
            title={t('files.selectFolder')}
            description={t('files.selectFolderHint')}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Toolbar />
      {isLoading && files.length === 0 ? (
        <LoadingOverlay message={t('files.loading')} />
      ) : files.length === 0 ? (
        <EmptyState
          title={t('files.noPdfs')}
          description={
            selectedFolder.last_scan_status === 'running'
              ? t('files.indexingHint')
              : t('files.emptyHint')
          }
        />
      ) : (
        <FileTable />
      )}
    </div>
  );
}
