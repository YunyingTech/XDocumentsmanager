import { useState } from 'react';
import { X, HardDrive, Network, FolderOpen } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { addFolder } from '../../lib/tauri';
import type { FolderConfig } from '../../types';
import { useI18n } from '../../lib/i18n';

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

  const handleSubmit = async () => {
    if (!path.trim()) {
      setError(t('addFolder.pathRequired'));
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="card w-[500px] max-w-[90vw] max-h-[85vh] overflow-auto shadow-lg" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-surface-200 dark:border-surface-800">
          <h2 className="text-lg font-semibold text-surface-900 dark:text-surface-100">
            {t('addFolder.title')}
          </h2>
          <button onClick={onClose} className="btn-ghost p-1.5 rounded-lg" title={t('addFolder.close')} aria-label={t('addFolder.close')}>
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Folder type toggle */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              {t('addFolder.type')}
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setFolderType('local')}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border transition-all
                  ${folderType === 'local'
                    ? 'bg-surface-100 dark:bg-surface-800 border-surface-300 dark:border-surface-600 text-surface-900 dark:text-surface-100'
                    : 'border-surface-200 dark:border-surface-700 text-surface-500 hover:bg-surface-50 dark:hover:bg-surface-900'
                  }`}
              >
                <HardDrive size={16} /> {t('addFolder.local')}
              </button>
              <button
                onClick={() => setFolderType('smb')}
                className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border transition-all
                  ${folderType === 'smb'
                    ? 'bg-surface-100 dark:bg-surface-800 border-surface-300 dark:border-surface-600 text-surface-900 dark:text-surface-100'
                    : 'border-surface-200 dark:border-surface-700 text-surface-500 hover:bg-surface-50 dark:hover:bg-surface-900'
                  }`}
              >
                <Network size={16} /> {t('addFolder.network')}
              </button>
            </div>
          </div>

          {/* Path */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
              {folderType === 'local' ? t('addFolder.path') : t('addFolder.smbPath')}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                className="input flex-1"
                placeholder={folderType === 'local'
                  ? 'C:\\Users\\Documents\\PDFs'
                  : '\\\\server\\share\\pdfs'
                }
                value={path}
                onChange={(e) => setPath(e.target.value)}
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
                  <FolderOpen size={16} />
                  {t('common.browse')}
                </button>
              )}
            </div>
            <p className="text-xs text-surface-400 mt-1">
              {folderType === 'local'
                ? t('addFolder.localPathHint')
                : t('addFolder.smbPathHint')
              }
            </p>
          </div>

          {/* Display name */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
              {t('addFolder.displayName')} <span className="text-surface-400">({t('common.optional')})</span>
            </label>
            <input
              type="text"
              className="input"
              placeholder={t('addFolder.displayNamePlaceholder')}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          {/* SMB credentials (only for SMB type) */}
          {folderType === 'smb' && (
            <div className="space-y-3 p-4 rounded-xl bg-surface-50 dark:bg-surface-900 border border-surface-200 dark:border-surface-800">
              <p className="text-xs text-surface-500">
                {t('addFolder.credentialsHint')}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">
                    {t('addFolder.username')}
                  </label>
                  <input
                    type="text"
                    className="input text-sm"
                    placeholder="username"
                    value={smbUsername}
                    onChange={(e) => setSmbUsername(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">
                    {t('addFolder.domain')}
                  </label>
                  <input
                    type="text"
                    className="input text-sm"
                    placeholder="DOMAIN"
                    value={smbDomain}
                    onChange={(e) => setSmbDomain(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-surface-600 dark:text-surface-400 mb-1">
                  {t('addFolder.password')}
                </label>
                <input
                  type="password"
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
            <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 pb-5">
          <button onClick={onClose} className="btn-secondary">{t('common.cancel')}</button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || !path.trim()}
            className="btn-primary"
          >
            {isSubmitting ? t('common.adding') : t('addFolder.title')}
          </button>
        </div>
      </div>
    </div>
  );
}
