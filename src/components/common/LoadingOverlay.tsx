import { Loader2 } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

interface LoadingOverlayProps {
  message?: string;
}

export function LoadingOverlay({ message }: LoadingOverlayProps) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <Loader2 size={28} className="text-accent-500 animate-spin" />
      <p className="text-sm text-surface-500">{message || t('common.loading')}</p>
    </div>
  );
}
