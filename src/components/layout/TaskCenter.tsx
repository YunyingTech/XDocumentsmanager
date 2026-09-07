import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Clipboard,
  CircleStop, Download, Loader2, ListChecks, Trash2,
  X,
} from 'lucide-react';
import { useFolderStore } from '../../stores/folderStore';
import { useOcrStore, type OcrTask } from '../../stores/ocrStore';
import type { IndexProgress } from '../../types';
import { useI18n, type TranslationKey } from '../../lib/i18n';

const activeOcrStatuses: OcrTask['status'][] = ['submitting', 'queued', 'running'];
const ocrStatusKeys: Record<OcrTask['status'], TranslationKey> = {
  submitting: 'tasks.submitting',
  queued: 'tasks.queued',
  running: 'tasks.processing',
  completed: 'tasks.completedStatus',
  failed: 'tasks.failedStatus',
  cancelled: 'tasks.cancelledStatus',
};
export function TaskCenter() {
  const { t, plural } = useI18n();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const indexProgressByJob = useFolderStore((s) => s.indexProgressByJob);
  const indexTasks = Object.values(indexProgressByJob);
  const folders = useFolderStore((s) => s.folders);
  const tasks = useOcrStore((s) => s.tasks);
  const bulkOcrRunning = useOcrStore((s) => s.bulkOcrRunning);
  const bulkOcrQueued = useOcrStore((s) => s.bulkOcrQueued);
  const clearTasks = useOcrStore((s) => s.clearTasks);
  const downloadResult = useOcrStore((s) => s.downloadResult);
  const cancelTask = useOcrStore((s) => s.cancelTask);
  const cancelAllTasks = useOcrStore((s) => s.cancelAllTasks);

  const indexActive = indexTasks.filter((progress) => progress.status === 'running' || progress.status === 'queued').length;
  const indexFailed = indexTasks.filter((progress) => progress.status === 'error').length;
  const activeOcr = tasks.filter((task) => activeOcrStatuses.includes(task.status)).length;
  const failedOcr = tasks.filter((task) => task.status === 'failed').length;
  const activeCount = (bulkOcrRunning ? Math.max(activeOcr, bulkOcrQueued, 1) : activeOcr) + indexActive;
  const failedCount = failedOcr + indexFailed;
  const hasHistory = tasks.length > 0 || indexTasks.length > 0;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const summary = activeCount > 0
    ? plural('tasks.running', activeCount)
    : failedCount > 0
      ? plural('tasks.attention', failedCount)
      : hasHistory ? t('tasks.completed') : t('tasks.none');

  return (
    <div ref={panelRef} className="relative flex h-full items-center">
      {open && (
        <section
          className="absolute bottom-[calc(100%+0.5rem)] right-0 z-40 w-[22rem] overflow-hidden rounded-lg border border-surface-200 bg-white shadow-[0_18px_50px_rgba(39,35,30,0.18)] dark:border-surface-700 dark:bg-surface-900"
          aria-label={t('tasks.center')}
        >
          <header className="flex h-12 items-center justify-between border-b border-surface-200 px-4 dark:border-surface-800">
            <div className="flex items-center gap-2">
              <ListChecks size={16} className="text-surface-500" />
              <h2 className="text-sm font-semibold text-surface-900 dark:text-surface-100">{t('tasks.title')}</h2>
              {activeCount > 0 && (
                <span className="rounded bg-accent-100 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-accent-700 dark:bg-accent-900/40 dark:text-accent-300">
                  {t('tasks.active', { count: activeCount })}
                </span>
              )}
            </div>
            {activeOcr > 0 || bulkOcrRunning ? (
              <button type="button" onClick={() => void cancelAllTasks()} className="icon-button text-surface-400 hover:text-red-600" title={t('tasks.cancelAllOcr')} aria-label={t('tasks.cancelAllOcr')}>
                <CircleStop size={15} />
              </button>
            ) : tasks.length > 0 && (
              <button type="button" onClick={clearTasks} className="icon-button text-surface-400 hover:text-red-600" title={t('tasks.clearOcr')} aria-label={t('tasks.clearOcr')}>
                <Trash2 size={15} />
              </button>
            )}
          </header>

          <div className="max-h-[min(28rem,60vh)] overflow-y-auto p-2">
            {!hasHistory && (
              <div className="flex flex-col items-center px-6 py-10 text-center">
                <ListChecks size={24} className="mb-3 text-surface-300 dark:text-surface-600" />
                <p className="text-sm font-medium text-surface-700 dark:text-surface-300">{t('tasks.none')}</p>
                <p className="mt-1 text-xs text-surface-400">{t('tasks.emptyHint')}</p>
              </div>
            )}
            {indexTasks.map((progress) => (
              <IndexTask key={progress.job_id} progress={progress} folderName={folders.find((folder) => folder.id === progress.folder_id)?.display_name} />
            ))}
            {tasks.length > 0 && (
              <div className={indexTasks.length > 0 ? 'mt-2 border-t border-surface-200 pt-2 dark:border-surface-800' : ''}>
                <p className="px-2 pb-1.5 text-[11px] font-semibold text-surface-400">OCR</p>
                <div className="space-y-1">
                  {[...tasks].reverse().map((task) => (
                    <OcrTaskRow key={`${task.fileId}-${task.taskId}-${task.submittedAt}`} task={task} onDownload={downloadResult} onCancel={cancelTask} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      <button type="button" onClick={() => setOpen((value) => !value)} className={`task-trigger ${open ? 'task-trigger-open' : ''}`} aria-expanded={open} aria-haspopup="dialog" title={t('tasks.open')}>
        {activeCount > 0 ? <Loader2 size={13} className="animate-spin text-accent-500" />
          : failedCount > 0 ? <AlertCircle size={13} className="text-red-500" />
          : hasHistory ? <CheckCircle2 size={13} className="text-emerald-600 dark:text-emerald-400" />
          : <ListChecks size={13} className="text-surface-400" />}
        <span className="max-w-48 truncate">{summary}</span>
        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
    </div>
  );
}

function IndexTask({ progress, folderName }: { progress: IndexProgress; folderName?: string | null }) {
  const { locale, t } = useI18n();
  const processed = Math.max(progress.files_processed, progress.files_indexed);
  const percentage = progress.files_total > 0 ? Math.min(100, Math.round((processed / progress.files_total) * 100)) : 0;
  const active = progress.status === 'running' || progress.status === 'queued';
  const failed = progress.status === 'error';

  return (
    <div className="rounded-md bg-surface-50 p-3 dark:bg-surface-800/60">
      <div className="flex items-start gap-2.5">
        {active ? <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-accent-500" />
          : failed ? <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-500" />
          : <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-600" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-surface-800 dark:text-surface-200">
                {t(progress.index_mode === 'full' ? 'tasks.fullIndexing' : 'tasks.incrementalIndexing')}
              </p>
              <p className="truncate text-[11px] text-surface-500">
                {folderName || t('tasks.documentLibrary')}
                {progress.ocr_after_index ? ` / ${t('tasks.ocrAfterIndex')}` : ''}
              </p>
            </div>
            <span className="shrink-0 text-[11px] font-medium tabular-nums text-surface-500">{active ? `${percentage}%` : failed ? t('tasks.failedStatus') : t('tasks.completedStatus')}</span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-sm bg-surface-200 dark:bg-surface-700">
            <div className={`h-full transition-[width] duration-300 ${failed ? 'bg-red-500' : active ? 'bg-accent-500' : 'bg-emerald-600'}`} style={{ width: `${active ? percentage : 100}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between gap-3 text-[11px] text-surface-400">
            <span className="truncate">{progress.current_file || t('tasks.filesProcessed', { count: processed.toLocaleString(locale) })}</span>
            {progress.files_total > 0 && <span className="shrink-0 tabular-nums">{processed.toLocaleString(locale)} / {progress.files_total.toLocaleString(locale)}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function OcrTaskRow({ task, onDownload, onCancel }: { task: OcrTask; onDownload: (taskId: string, fileId: number) => Promise<void>; onCancel: (taskId: string) => Promise<void> }) {
  const { t } = useI18n();
  const active = activeOcrStatuses.includes(task.status);
  const failed = task.status === 'failed';
  const cancelled = task.status === 'cancelled';
  const percentage = task.progress == null ? null : Math.min(100, Math.max(0, Math.round(task.progress)));

  return (
    <div className="flex min-h-12 items-center gap-2.5 rounded-md px-2 py-2 hover:bg-surface-50 dark:hover:bg-surface-800/60">
      {active ? <Loader2 size={15} className="shrink-0 animate-spin text-accent-500" />
        : failed ? <AlertCircle size={15} className="shrink-0 text-red-500" />
        : cancelled ? <X size={15} className="shrink-0 text-surface-400" />
        : <CheckCircle2 size={15} className="shrink-0 text-emerald-600" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-xs font-medium text-surface-700 dark:text-surface-300">{task.fileName}</p>
          <span className={`shrink-0 text-[11px] font-medium ${failed ? 'text-red-600 dark:text-red-400' : active ? 'text-accent-700 dark:text-accent-300' : cancelled ? 'text-surface-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
            {t(ocrStatusKeys[task.status])}{percentage !== null && active ? ` ${percentage}%` : ''}
          </span>
        </div>
        {task.error ? <p className="mt-0.5 truncate text-[11px] text-red-500" title={task.error}>{task.error}</p>
          : task.status === 'queued' && task.queuedAhead != null ? <p className="mt-0.5 text-[11px] text-surface-400">{t('tasks.queueAhead', { count: task.queuedAhead })}</p>
          : <p className="mt-0.5 text-[11px] text-surface-400">{task.engine === 'rapid' ? 'RapidOCR' : task.engine === 'windows' ? 'Windows OCR' : task.engine === 'paddle' ? 'PaddleOCR' : 'MinerU'} - {t('tasks.ocrProcessing')}</p>}
      </div>
      {active && (
        <button type="button" onClick={() => void onCancel(task.taskId)} className="icon-button shrink-0 text-surface-400 hover:text-red-600" title={t('tasks.cancel')} aria-label={t('tasks.cancelFor', { name: task.fileName })}>
          <X size={14} />
        </button>
      )}
      {task.status === 'completed' && !task.resultPath && (
        <button type="button" onClick={() => onDownload(task.taskId, task.fileId)} className="icon-button shrink-0" title={t('tasks.downloadResult')} aria-label={t('tasks.downloadResultFor', { name: task.fileName })}>
          <Download size={14} />
        </button>
      )}
      {task.resultPath && (
        <button type="button" onClick={() => navigator.clipboard.writeText(task.resultPath!)} className="icon-button shrink-0" title={t('tasks.copyResultPath')} aria-label={t('tasks.copyResultPathFor', { name: task.fileName })}>
          <Clipboard size={14} />
        </button>
      )}
    </div>
  );
}
