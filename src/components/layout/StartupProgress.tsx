import type { StartupStatus } from '../../types';
import { useI18n } from '../../lib/i18n';

export function StartupProgress({ status, compact = false }: { status: StartupStatus; compact?: boolean }) {
  const { t, locale } = useI18n();
  const stage = status.phase === 'search_starting' ? t('startup.searchStarting')
    : status.phase === 'search_sync' ? t('startup.searchSync')
    : status.phase === 'local_index' ? t('startup.localIndex') : t('startup.database');
  if (status.phase === 'ready') return status.error
    ? <span className="max-w-xs truncate px-2 text-amber-600" title={status.error}>{t('startup.localSearch')}</span> : null;
  if (status.phase === 'failed') return null;
  const steps = status.completed_steps ?? ({ database: 0, local_index: 1, search_starting: 2, search_sync: 3 }[status.phase]);
  const count = status.total != null && status.total > 0
    ? `${(status.processed ?? 0).toLocaleString(locale)} / ${status.total.toLocaleString(locale)}` : null;
  return <div title={stage} className={compact ? 'flex max-w-md items-center gap-2 px-2' : 'w-full max-w-sm space-y-2'}>
    <div className={compact ? 'min-w-0 truncate' : 'flex items-center justify-between gap-3 text-xs text-surface-500'}>
      <span>{compact && status.ready ? t('startup.background') : stage}</span>
      <span className={compact ? 'ml-2 tabular-nums' : 'tabular-nums'}>{t('startup.stages', { done: steps, total: 4 })} · {Math.floor((status.elapsed_ms ?? 0) / 1000)}s</span>
    </div>
    <progress aria-label={t('startup.progress')} max={4} value={steps} className={compact ? 'h-1.5 w-20 shrink-0 accent-accent-500' : 'h-2 w-full accent-accent-500'} />
    {count && <span className="text-xs tabular-nums text-surface-500" title={stage}>{count}</span>}
    {!compact && <p className="text-xs text-surface-400">{t('startup.stageHint')}</p>}
  </div>;
}
