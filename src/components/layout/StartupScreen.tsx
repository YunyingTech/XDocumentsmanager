import { AlertTriangle, Loader2 } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import type { StartupStatus } from '../../types';

export function StartupScreen({ status }: { status: StartupStatus }) {
  const { t } = useI18n();
  const failed = status.phase === 'failed';
  const message = status.phase === 'local_index' ? t('startup.localIndex')
    : status.phase === 'search_starting' ? t('startup.searchStarting')
    : status.phase === 'search_sync' ? t('startup.searchSync') : t('startup.database');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role={failed ? 'alert' : 'status'} aria-live="polite" aria-busy={!failed}>
      {failed ? <AlertTriangle className="text-red-500" size={28} aria-hidden="true" />
        : <Loader2 className="animate-spin text-accent-500" size={28} aria-hidden="true" />}
      <p className="text-sm font-medium text-surface-800 dark:text-surface-100">{failed ? t('startup.failed') : t('startup.loading')}</p>
      <p className="max-w-lg break-words text-xs text-surface-500">{failed ? status.error : message}</p>
      <p className="max-w-lg text-xs text-surface-400">{failed ? t('startup.failureHint') : t('startup.logsHint')}</p>
    </div>
  );
}
