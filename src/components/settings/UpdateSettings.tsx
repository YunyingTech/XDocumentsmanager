import { Check, Download, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { useUpdateStore } from '../../stores/updateStore';
import { useFolderStore } from '../../stores/folderStore';
import { useOcrStore } from '../../stores/ocrStore';
import { useI18n } from '../../lib/i18n';

export function UpdateSettings() {
  const { t } = useI18n();
  const state = useUpdateStore();
  const indexing = Object.values(useFolderStore((s) => s.indexProgressByJob)).some((job) => ['queued', 'running', 'paused'].includes(job.status));
  const busyOcr = useOcrStore((s) => s.isSubmitting || s.bulkOcrRunning || s.isInstallingPaddle || s.isInstallingRapid || s.tasks.some((task) => ['submitting', 'queued', 'running'].includes(task.status)));
  const busy = indexing || busyOcr;
  const labels = {
    checking: t('updates.checking'), available: t('updates.available', { version: state.version ?? '' }),
    downloading: t('updates.downloading'), verifying: t('updates.verifying'),
    ready: t('updates.ready', { version: state.version ?? '' }), installing: t('updates.installing'),
    up_to_date: t('updates.upToDate'), error: t('updates.error', { error: state.error ?? '' }),
  };
  const operationActive = state.busy || ['checking', 'downloading', 'verifying', 'installing'].includes(state.phase);
  const percent = state.total ? Math.min(100, Math.floor(state.downloaded * 100 / state.total)) : null;
  return (
    <section className="card p-5" aria-labelledby="updates-heading">
      <h3 id="updates-heading" className="mb-4 text-sm font-semibold text-surface-900 dark:text-surface-100">{t('updates.title')}</h3>
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
          <input type="checkbox" checked={state.checkOnStartup} onChange={(event) => void state.setPreference('updates_check_on_startup', event.target.checked)} />{t('updates.checkOnStartup')}
        </label>
        <label className="flex items-center gap-2 text-sm text-surface-700 dark:text-surface-300">
          <input type="checkbox" checked={state.autoDownload} onChange={(event) => void state.setPreference('updates_auto_download', event.target.checked)} />{t('updates.autoDownload')}
        </label>
        {state.phase !== 'idle' && <div className="space-y-2 text-xs text-surface-500" role="status" aria-live="polite">
          <p>{labels[state.phase as keyof typeof labels] ?? state.phase}</p>
          {percent !== null && state.phase === 'downloading' && <progress className="h-1.5 w-full accent-emerald-600" max={100} value={percent} aria-label={labels.downloading} />}
          {state.error && <p>{state.error}</p>}
        </div>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void state.check()} disabled={operationActive} className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm disabled:opacity-50">
            {operationActive ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}{t('updates.check')}
          </button>
          {state.phase === 'available' && <button type="button" onClick={() => void state.download()} disabled={operationActive} className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm disabled:opacity-50"><Download size={14} />{t('updates.download')}</button>}
          {state.phase === 'ready' && <button type="button" onClick={() => void state.install()} disabled={operationActive || busy} title={busy ? t('updates.waitForTasks') : undefined} className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm disabled:opacity-50">
            {operationActive ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}{t('updates.install')}
          </button>}
          {state.phase === 'up_to_date' && <Check size={16} className="text-emerald-600" aria-hidden="true" />}
        </div>
        {busy && state.phase === 'ready' && <p className="text-xs text-surface-500">{t('updates.waitForTasks')}</p>}
      </div>
    </section>
  );
}
