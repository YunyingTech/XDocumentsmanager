import { Database, HardDrive } from 'lucide-react';
import { useFolderStore } from '../../stores/folderStore';
import { formatFileSize } from '../../lib/format';
import { TaskCenter } from './TaskCenter';
import { useI18n } from '../../lib/i18n';

export function StatusBar() {
  const { locale, t } = useI18n();
  const folders = useFolderStore((s) => s.folders);
  const totalFiles = folders.reduce((sum, folder) => sum + folder.total_files, 0);
  const totalSize = folders.reduce((sum, folder) => sum + folder.total_size_bytes, 0);

  return (
    <footer className="relative z-30 flex h-9 shrink-0 select-none items-center border-t border-surface-200 bg-white px-3 text-xs text-surface-500 dark:border-surface-800 dark:bg-surface-950">
      <div className="flex min-w-0 items-center gap-4" aria-label={t('status.libraryStatistics')}>
        <span className="flex items-center gap-1.5 whitespace-nowrap"><Database size={13} />{t('status.documents', { count: totalFiles.toLocaleString(locale) })}</span>
        {totalSize > 0 && <span className="hidden items-center gap-1.5 whitespace-nowrap sm:flex"><HardDrive size={13} /><span className="tabular-nums">{formatFileSize(totalSize)}</span></span>}
      </div>
      <div className="ml-auto h-full"><TaskCenter /></div>
    </footer>
  );
}
