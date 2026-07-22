import { Circle, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

interface FolderStatusBadgeProps {
  status: 'never' | 'running' | 'completed' | 'error';
}

export function FolderStatusBadge({ status }: FolderStatusBadgeProps) {
  const { t } = useI18n();
  switch (status) {
    case 'running':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-accent-500">
          <Loader2 size={10} className="animate-spin" /> {t('folders.statusIndexing')}
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
          <CheckCircle2 size={10} /> {t('folders.statusIndexed')}
        </span>
      );
    case 'error':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-red-500">
          <XCircle size={10} /> {t('folders.statusError')}
        </span>
      );
    case 'never':
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs text-surface-400">
          <Circle size={10} /> {t('folders.statusNotIndexed')}
        </span>
      );
  }
}
