import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

export interface ToastData {
  id: string;
  type: 'success' | 'error';
  message: string;
}

interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

export function ToastItem({ toast, onDismiss }: ToastProps) {
  const { t } = useI18n();
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(() => onDismiss(toast.id), 200);
    }, 4000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div
      role={toast.type === 'error' ? 'alert' : 'status'}
      aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
      className={`flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg border text-sm
        ${toast.type === 'success'
          ? 'bg-green-50 border-green-200 text-green-800 dark:bg-green-950 dark:border-green-800 dark:text-green-200'
          : 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950 dark:border-red-800 dark:text-red-200'
        }
        ${exiting ? 'opacity-0 translate-x-4' : 'opacity-100'}
        transition-[opacity,transform] duration-200
      `}
    >
      {toast.type === 'success'
        ? <CheckCircle2 size={16} className="shrink-0" aria-hidden="true" />
        : <XCircle size={16} className="shrink-0" aria-hidden="true" />
      }
      <span className="flex-1">{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10"
        title={t('common.close')}
        aria-label={t('common.close')}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
