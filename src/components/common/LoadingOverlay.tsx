import { Loader2 } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

interface LoadingOverlayProps {
  message?: string;
}

export function LoadingOverlay({ message }: LoadingOverlayProps) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3" role="status" aria-live="polite">
      <Loader2 size={28} className="animate-spin text-accent-500" aria-hidden="true" />
      <p className="text-sm text-surface-500">{message || t('common.loading')}</p>
    </div>
  );
}
