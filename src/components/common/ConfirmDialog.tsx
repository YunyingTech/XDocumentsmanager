import { useId } from 'react';
import { useI18n } from '../../lib/i18n';
import { useDialogFocus } from '../../hooks/useDialogFocus';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}

export function ConfirmDialog({
  open, title, message, confirmLabel, cancelLabel,
  onConfirm, onCancel, danger = false,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useDialogFocus(open, onCancel);
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain bg-black/40 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        className="card w-96 max-w-[calc(100vw-2rem)] p-6 shadow-lg"
      >
        <h2 id={titleId} className="mb-2 text-lg font-semibold text-surface-900 text-balance dark:text-surface-100">
          {title}
        </h2>
        <p id={messageId} className="mb-6 text-sm text-surface-500 text-pretty">{message}</p>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="btn-secondary" data-dialog-initial-focus>{cancelLabel || t('common.cancel')}</button>
          <button
            type="button"
            onClick={onConfirm}
            className={danger ? 'btn bg-red-500 text-white hover:bg-red-600' : 'btn-primary'}
          >
            {confirmLabel || t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
