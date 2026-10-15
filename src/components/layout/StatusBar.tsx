import { AlertCircle, Database, Download, HardDrive, Loader2, RotateCcw } from 'lucide-react';
import { useFolderStore } from '../../stores/folderStore';
import { formatFileSize } from '../../lib/format';
import { TaskCenter } from './TaskCenter';
import { useI18n } from '../../lib/i18n';
import { useUpdateStore } from '../../stores/updateStore';
import { useOcrStore } from '../../stores/ocrStore';

function UpdateStatusControl() {
  const { t } = useI18n();
  const update = useUpdateStore();
  const indexing = useFolderStore((s) => Object.values(s.indexProgressByJob).some((job) => ['queued', 'running', 'paused'].includes(job.status)));
  const busyOcr = useOcrStore((s) => s.isSubmitting || s.bulkOcrRunning || s.isInstallingPaddle || s.isInstallingRapid || s.tasks.some((task) => ['submitting', 'queued', 'running'].includes(task.status)));
  if (['idle', 'up_to_date'].includes(update.phase)) return null;
  const loading = update.busy || ['checking', 'downloading', 'verifying', 'installing'].includes(update.phase);
  const label = update.phase === 'ready'
    ? t('updates.install')
    : update.phase === 'available'
      ? t('updates.available', { version: update.version ?? '' })
      : update.phase === 'error'
        ? t('updates.error', { error: update.error ?? '' })
        : update.phase === 'downloading' && update.total
          ? `${t('updates.downloading')} ${Math.floor(update.downloaded * 100 / update.total)}%`
          : t(`updates.${update.phase}` as Parameters<typeof t>[0]);
  if (update.phase === 'ready') {
    const blocked = indexing || busyOcr;
    return <button type="button" title={blocked ? t('updates.waitForTasks') : label} disabled={loading || blocked} onClick={() => void update.install()} className="inline-flex h-full items-center gap-1.5 px-2 font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-400 dark:hover:bg-surface-900">
      <RotateCcw size={13} />{label}
    </button>;
  }
  return <span className="inline-flex h-full items-center gap-1.5 px-2" title={update.error ?? undefined}>
    {loading ? <Loader2 size={13} className="animate-spin" /> : update.phase === 'error' ? <AlertCircle size={13} /> : <Download size={13} />}{label}
  </span>;
}

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
      <div className="ml-auto flex h-full items-center"><UpdateStatusControl /><TaskCenter /></div>
    </footer>
  );
}
