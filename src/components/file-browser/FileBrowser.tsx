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
import { PdfViewer } from '../viewer/PdfViewer';

export function FileBrowser() {
  const { t } = useI18n();
  const selectedFolderId = useFolderStore((s) => s.selectedFolderId);
  const folders = useFolderStore((s) => s.folders);
  const files = useFileStore((s) => s.files);
  const isLoading = useFileStore((s) => s.isLoading);
  const loadFiles = useFileStore((s) => s.loadFiles);
  const selectedFileId = useFileStore((s) => s.selectedFileId);
  const selectFile = useFileStore((s) => s.selectFile);
  const setView = useUIStore((s) => s.setView);

  const selectedFolder = folders.find((f) => f.id === selectedFolderId);
  const selectedFile = files.find((file) => file.id === selectedFileId);

  useEffect(() => {
    selectFile(null);
    if (selectedFolderId !== null) {
      loadFiles(selectedFolderId);
    }
  }, [selectedFolderId, loadFiles, selectFile]);

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
        <div className={`grid min-h-0 flex-1 ${selectedFile ? 'md:grid-cols-[minmax(320px,42%)_minmax(0,1fr)]' : ''}`}>
          <div className={`min-h-0 overflow-hidden ${selectedFile ? 'hidden border-r border-surface-200 md:flex dark:border-surface-800' : 'flex'}`}>
            <FileTable compact={Boolean(selectedFile)} />
          </div>
          {selectedFile && (
            <div className="min-h-0 min-w-0">
              <PdfViewer
                filePath={joinWindowsPath(selectedFolder.path, selectedFile.relative_path)}
                fileName={selectedFile.file_name}
                mode="embedded"
                onClose={() => selectFile(null)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function joinWindowsPath(basePath: string, relativePath: string): string {
  return `${basePath.replace(/[\\/]$/, '')}\\${relativePath.replace(/^[\\/]/, '')}`;
}
