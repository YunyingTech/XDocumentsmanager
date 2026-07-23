import { type FormEvent, useId, useRef, useState } from 'react';
import { X, HardDrive, Network, FolderOpen } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { addFolder } from '../../lib/tauri';
import type { FolderConfig } from '../../types';
import { useI18n } from '../../lib/i18n';
import { useDialogFocus } from '../../hooks/useDialogFocus';

interface AddFolderDialogProps {
  onClose: () => void;
  onAdded: () => void;
}

export function AddFolderDialog({ onClose, onAdded }: AddFolderDialogProps) {
  const { t } = useI18n();
  const [path, setPath] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [folderType, setFolderType] = useState<'local' | 'smb'>('local');
  const [smbUsername, setSmbUsername] = useState('');
  const [smbDomain, setSmbDomain] = useState('');
  const [smbPassword, setSmbPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogFocus(true, onClose);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const pathId = `${id}-path`;
  const pathHintId = `${id}-path-hint`;
  const errorId = `${id}-error`;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!path.trim()) {
      setError(t('addFolder.pathRequired'));
      pathInputRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const config: FolderConfig = {
        display_name: displayName.trim() || undefined,
        folder_type: folderType,
      };

      if (folderType === 'smb') {
        if (smbUsername) config.smb_username = smbUsername;
        if (smbDomain) config.smb_domain = smbDomain;
        if (smbPassword) config.smb_password = smbPassword;
      }

      await addFolder(path.trim(), config);
      onAdded();
    } catch (err: any) {
      setError(err ? t('addFolder.failedWithReason', { error: String(err) }) : t('addFolder.failed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain bg-black/40 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="card max-h-[85vh] w-[500px] max-w-[90vw] overflow-auto overscroll-contain shadow-lg"
      >
        <form onSubmit={handleSubmit} noValidate>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-surface-200 dark:border-surface-800">
          <h2 id={titleId} className="text-lg font-semibold text-surface-900 text-balance dark:text-surface-100">
            {t('addFolder.title')}
          </h2>
          <button type="button" onClick={onClose} disabled={isSubmitting} className="btn-ghost p-1.5 rounded-lg" title={t('addFolder.close')} aria-label={t('addFolder.close')}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Folder type toggle */}
          <fieldset>
            <legend className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              {t('addFolder.type')}
            </legend>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFolderType('local')}
                aria-pressed={folderType === 'local'}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium border transition-[color,background-color,border-color,box-shadow]
                  ${folderType === 'local'
                    ? 'bg-surface-100 dark:bg-surface-800 border-surface-300 dark:border-surface-600 text-surface-900 dark:text-surface-100'
                    : 'border-surface-200 dark:border-surface-700 text-surface-500 hover:bg-surface-50 dark:hover:bg-surface-900'
                  }`}
              >
                <HardDrive size={16} aria-hidden="true" /> {t('addFolder.local')}
              </button>
              <button
                type="button"
                onClick={() => setFolderType('smb')}
                aria-pressed={folderType === 'smb'}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium border transition-[color,background-color,border-color,box-shadow]
                  ${folderType === 'smb'
                    ? 'bg-surface-100 dark:bg-surface-800 border-surface-300 dark:border-surface-600 text-surface-900 dark:text-surface-100'
                    : 'border-surface-200 dark:border-surface-700 text-surface-500 hover:bg-surface-50 dark:hover:bg-surface-900'
                  }`}
              >
                <Network size={16} aria-hidden="true" /> {t('addFolder.network')}
              </button>
            </div>
          </fieldset>

          {/* Path */}
          <div>
            <label htmlFor={pathId} className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
              {folderType === 'local' ? t('addFolder.path') : t('addFolder.smbPath')}
            </label>
            <div className="flex gap-2">
              <input
                ref={pathInputRef}
                id={pathId}
                name="folder_path"
                type="text"
                autoComplete="off"
                spellCheck={false}
                data-dialog-initial-focus
                className="input flex-1"
                placeholder={folderType === 'local'
                  ? 'C:\\Users\\Documents\\PDFs…'
                  : '\\\\server\\share\\pdfs…'
                }
                value={path}
                aria-invalid={Boolean(error)}
                aria-describedby={`${pathHintId}${error ? ` ${errorId}` : ''}`}
                onChange={(e) => {
                  setPath(e.target.value);
                  if (error) setError(null);
                }}
              />
              {folderType === 'local' && (
                <button
                  type="button"
                  className="btn-secondary flex items-center gap-1.5"
                  onClick={async () => {
                    const selected = await open({
                      directory: true,
                      title: t('addFolder.select'),
                    });
                    if (selected && typeof selected === 'string') {
                      setPath(selected);
                    }
                  }}
                >
                  <FolderOpen size={16} aria-hidden="true" />
                  {t('common.browse')}
                </button>
              )}
            </div>
            <p id={pathHintId} className="text-xs text-surface-400 mt-1">
              {folderType === 'local'
                ? t('addFolder.localPathHint')
                : t('addFolder.smbPathHint')
              }
            </p>
          </div>

          {/* Display name */}
          <div>
            <label htmlFor={`${id}-display-name`} className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
              {t('addFolder.displayName')} <span className="text-surface-400">({t('common.optional')})</span>
            </label>
            <input
              id={`${id}-display-name`}
              name="display_name"
              type="text"
              autoComplete="off"
              className="input"
              placeholder={`${t('addFolder.displayNamePlaceholder')}…`}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          {/* SMB credentials (only for SMB type) */}
          {folderType === 'smb' && (
            <div className="space-y-3 rounded-lg border border-surface-200 bg-surface-50 p-4 dark:border-surface-800 dark:bg-surface-900">
              <p className="text-xs text-surface-500">
                {t('addFolder.credentialsHint')}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor={`${id}-username`} className="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">
                    {t('addFolder.username')}
                  </label>
                  <input
                    id={`${id}-username`}
                    name="smb_username"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    className="input text-sm"
                    placeholder="username…"
                    value={smbUsername}
                    onChange={(e) => setSmbUsername(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor={`${id}-domain`} className="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">
                    {t('addFolder.domain')}
                  </label>
                  <input
                    id={`${id}-domain`}
                    name="smb_domain"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    className="input text-sm"
                    placeholder="DOMAIN…"
                    value={smbDomain}
                    onChange={(e) => setSmbDomain(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label htmlFor={`${id}-password`} className="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">
                  {t('addFolder.password')}
                </label>
                <input
                  id={`${id}-password`}
                  name="smb_password"
                  type="password"
                  autoComplete="off"
                  className="input text-sm"
                  placeholder="••••••••"
                  value={smbPassword}
                  onChange={(e) => setSmbPassword(e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div id={errorId} role="alert" aria-live="assertive" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 pb-5">
          <button type="button" onClick={onClose} disabled={isSubmitting} className="btn-secondary">{t('common.cancel')}</button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="btn-primary"
          >
            {isSubmitting ? t('common.adding') : t('addFolder.title')}
          </button>
        </div>
        </form>
      </div>
    </div>
  );
}
