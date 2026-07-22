import { useEffect } from 'react';
import {
  ScanText,
  CheckCircle,
  Loader2,
  RefreshCw,
  Wifi,
  WifiOff,
  FileText,
} from 'lucide-react';
import { useOcrStore } from '../../stores/ocrStore';
import { useFolderStore } from '../../stores/folderStore';
import { formatFileSize } from '../../lib/format';
import { useI18n } from '../../lib/i18n';

export function OcrPage() {
  const { t } = useI18n();
  const store = useOcrStore();

  // Load settings and health on mount
  useEffect(() => {
    store.loadSettings().then(() => {
      store.checkHealth();
    });
    store.loadCandidates();
  }, []);

  return (
    <div className="flex flex-col h-full relative">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
            {t('nav.ocr')}
          </h2>
          {/* Health indicator */}
          <HealthBadge />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { store.checkHealth(); store.loadCandidates(); }}
            className="btn-ghost p-1.5 rounded-lg"
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
          >
            <RefreshCw size={16} className={store.healthChecking ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-5xl space-y-6">
          {/* ── Settings card ── */}
          <SettingsCard />

          {/* ── File selection ── */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                {t('ocr.selectFiles')}
              </h3>
              <div className="flex items-center gap-2">
                <button onClick={store.selectAll} className="btn-ghost text-xs px-2 py-1 rounded">
                  {t('ocr.selectAll')}
                </button>
                <button onClick={store.deselectAll} className="btn-ghost text-xs px-2 py-1 rounded">
                  {t('ocr.deselectAll')}
                </button>
                {store.candidates.length > 0 && (
                  <button
                    onClick={() => store.submitTasks()}
                    disabled={
                      store.selectedFileIds.size === 0 ||
                      !store.health?.connected
                    }
                    className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ScanText size={16} className="inline mr-1.5" />
                    {t('ocr.start', { count: store.selectedFileIds.size })}
                  </button>
                )}
              </div>
            </div>

            {store.loadingCandidates ? (
              <div className="flex items-center justify-center py-8 text-surface-400">
                <Loader2 size={20} className="animate-spin mr-2" />
                {t('ocr.loadingFiles')}
              </div>
            ) : store.candidates.length === 0 ? (
              <div className="text-center py-8 text-surface-400">
                <FileText size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">{t('ocr.noFiles')}</p>
                <p className="text-xs mt-1">{t('ocr.noFilesHint')}</p>
              </div>
            ) : (
              <FileTable />
            )}

          </div>

        </div>
      </div>

    </div>
  );
}
// ── Sub-components ──

function HealthBadge() {
  const { t } = useI18n();
  const health = useOcrStore((s) => s.health);
  const healthChecking = useOcrStore((s) => s.healthChecking);

  if (healthChecking) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-surface-400">
        <Loader2 size={12} className="animate-spin" />
        {t('ocr.checking')}
      </span>
    );
  }
  if (!health) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-surface-400">
        <WifiOff size={12} />
        {t('ocr.notChecked')}
      </span>
    );
  }
  if (health.connected) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
        <Wifi size={12} />
        {t('ocr.connectedTo', { url: health.api_url })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-red-500">
      <WifiOff size={12} />
      {t('ocr.disconnectedFrom', { url: health.api_url })}
    </span>
  );
}

function SettingsCard() {
  const { t } = useI18n();
  const apiUrl = useOcrStore((s) => s.apiUrl);
  const outputDir = useOcrStore((s) => s.outputDir);
  const saveApiUrl = useOcrStore((s) => s.saveApiUrl);
  const saveOutputDir = useOcrStore((s) => s.saveOutputDir);

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
        {t('ocr.settings')}
      </h3>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-surface-500 mb-1">
            {t('ocr.apiUrl')}
          </label>
          <input
            type="text"
            className="input text-sm"
            value={apiUrl}
            onChange={(e) => saveApiUrl(e.target.value)}
            placeholder="http://127.0.0.1:8000"
          />
        </div>
        <div>
          <label className="block text-xs text-surface-500 mb-1">
            {t('ocr.outputDirectory')}
          </label>
          <input
            type="text"
            className="input text-sm"
            value={outputDir}
            onChange={(e) => saveOutputDir(e.target.value)}
            placeholder={t('ocr.outputPlaceholder', { project: '{project}' })}
          />
        </div>
      </div>
    </div>
  );
}

function FileTable() {
  const { locale, t } = useI18n();
  const candidates = useOcrStore((s) => s.candidates);
  const selectedFileIds = useOcrStore((s) => s.selectedFileIds);
  const toggleFile = useOcrStore((s) => s.toggleFile);
  const folders = useFolderStore((s) => s.folders);
  const page = useOcrStore((s) => s.page);
  const totalPages = useOcrStore((s) => s.totalPages);
  const totalCandidates = useOcrStore((s) => s.totalCandidates);
  const setPage = useOcrStore((s) => s.setPage);
  const loadCandidates = useOcrStore((s) => s.loadCandidates);

  const getFolderPath = (folderId: number) => {
    const f = folders.find((f) => f.id === folderId);
    return f?.display_name || f?.path?.split('\\').pop() || t('ocr.folderNumber', { id: folderId });
  };

  const handlePageChange = (newPage: number) => {
    if (newPage < 0 || newPage >= totalPages) return;
    setPage(newPage);
    loadCandidates();
  };

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-200 dark:border-surface-800">
              <th className="w-8 py-2 text-left">
                <span className="sr-only">{t('common.select')}</span>
              </th>
              <th className="py-2 text-left text-xs font-medium text-surface-500">{t('ocr.fileName')}</th>
              <th className="py-2 text-left text-xs font-medium text-surface-500">{t('ocr.folder')}</th>
              <th className="py-2 text-right text-xs font-medium text-surface-500">{t('ocr.size')}</th>
              <th className="py-2 text-right text-xs font-medium text-surface-500">{t('ocr.status')}</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((file) => {
              const isSelected = selectedFileIds.has(file.id);
              return (
                <tr
                  key={file.id}
                  onClick={() => toggleFile(file.id)}
                  className={`border-b border-surface-100 dark:border-surface-900 cursor-pointer transition-colors hover:bg-surface-50 dark:hover:bg-surface-900 ${
                    isSelected ? 'bg-accent-50 dark:bg-accent-950/30' : ''
                  }`}
                >
                  <td className="py-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleFile(file.id)}
                      className="rounded"
                    />
                  </td>
                  <td className="py-2 text-surface-700 dark:text-surface-300 truncate max-w-64">
                    {file.file_name}
                  </td>
                  <td className="py-2 text-surface-500 text-xs">
                    {getFolderPath(file.folder_id)}
                  </td>
                  <td className="py-2 text-right text-surface-500 text-xs tabular-nums">
                    {formatFileSize(file.file_size_bytes)}
                  </td>
                  <td className="py-2 text-right">
                    {file.ocr_applied ? (
                      <span className="text-xs text-green-600 inline-flex items-center gap-1">
                        <CheckCircle size={12} /> {t('ocr.done')}
                      </span>
                    ) : (
                      <span className="text-xs text-surface-400">-</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-3 border-t border-surface-200 dark:border-surface-800">
          <span className="text-xs text-surface-500">
            {t('files.total', { count: totalCandidates.toLocaleString(locale) })}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handlePageChange(page - 1)}
              disabled={page <= 0}
              className="btn-ghost px-2 py-1 rounded text-xs disabled:opacity-30"
            >
              {t('common.previous')}
            </button>
            <span className="text-xs text-surface-600 dark:text-surface-400 tabular-nums">
              {t('files.pageOf', { page: page + 1, total: totalPages })}
            </span>
            <button
              onClick={() => handlePageChange(page + 1)}
              disabled={page >= totalPages - 1}
              className="btn-ghost px-2 py-1 rounded text-xs disabled:opacity-30"
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
