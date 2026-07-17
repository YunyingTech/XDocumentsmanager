import { useEffect } from 'react';
import { useFolderStore } from '../../stores/folderStore';
import { useFileStore } from '../../stores/fileStore';
import { FileTable } from './FileTable';
import { Toolbar } from './Toolbar';
import { EmptyState } from '../common/EmptyState';
import { LoadingOverlay } from '../common/LoadingOverlay';
import { Plus } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';

export function FileBrowser() {
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
            title="No folders indexed"
            description="Add a local folder or SMB network share to start indexing your PDF documents."
            action={{ label: 'Add Folder', onClick: () => setView('folders') }}
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
            title="Select a folder"
            description="Choose a folder from the sidebar to browse its PDF files."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Toolbar />
      {isLoading && files.length === 0 ? (
        <LoadingOverlay message="Loading files..." />
      ) : files.length === 0 ? (
        <EmptyState
          title="No PDFs found"
          description={
            selectedFolder.last_scan_status === 'running'
              ? 'Indexing is in progress. Files will appear here shortly.'
              : 'This folder has no PDF files, or indexing has not been started yet.'
          }
        />
      ) : (
        <FileTable />
      )}
    </div>
  );
}
