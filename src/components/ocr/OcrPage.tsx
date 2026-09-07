import { MAX_RAPID_OCR_WORKERS } from '../../lib/rapidOcrConfig';
import { useEffect, useState } from 'react';
import {
  ScanText,
  CheckCircle,
  Loader2,
  RefreshCw,
  Wifi,
  WifiOff,
  FileText,
  Monitor,
  Server,
  Boxes,
  Download,
  Zap,
} from 'lucide-react';
import { useOcrStore } from '../../stores/ocrStore';
import { useFolderStore } from '../../stores/folderStore';
import { formatFileSize } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import type { PaddleDeviceMode, PaddleOcrStatus, PaddlePackageIndex, RapidDeviceMode, RapidOcrStatus } from '../../types';

const paddleInstallStageLabels = {
  preparing: 'ocr.paddleStagePreparing',
  extracting: 'ocr.paddleStageExtracting',
  installing: 'ocr.paddleStageInstalling',
  verifying: 'ocr.paddleStageVerifying',
  completed: 'ocr.paddleStageCompleted',
  failed: 'ocr.paddleStageFailed',
} as const;

const rapidInstallStageLabels = {
  preparing: 'ocr.rapidStagePreparing',
  extracting: 'ocr.rapidStageExtracting',
  installing: 'ocr.rapidStageInstalling',
  verifying: 'ocr.rapidStageVerifying',
  completed: 'ocr.rapidStageCompleted',
  failed: 'ocr.rapidStageFailed',
} as const;

export function OcrPage() {
  const { t } = useI18n();
  const engine = useOcrStore((state) => state.engine);
  const health = useOcrStore((state) => state.health);
  const windowsStatus = useOcrStore((state) => state.windowsStatus);
  const paddleStatus = useOcrStore((state) => state.paddleStatus);
  const rapidStatus = useOcrStore((state) => state.rapidStatus);
  const healthChecking = useOcrStore((state) => state.healthChecking);
  const candidates = useOcrStore((state) => state.candidates);
  const totalCandidates = useOcrStore((state) => state.totalCandidates);
  const loadingCandidates = useOcrStore((state) => state.loadingCandidates);
  const selectedFileIds = useOcrStore((state) => state.selectedFileIds);
  const isSubmitting = useOcrStore((state) => state.isSubmitting);
  const bulkOcrRunning = useOcrStore((state) => state.bulkOcrRunning);
  const bulkOcrQueued = useOcrStore((state) => state.bulkOcrQueued);
  const loadSettings = useOcrStore((state) => state.loadSettings);
  const checkHealth = useOcrStore((state) => state.checkHealth);
  const loadCandidates = useOcrStore((state) => state.loadCandidates);
  const selectAll = useOcrStore((state) => state.selectAll);
  const deselectAll = useOcrStore((state) => state.deselectAll);
  const submitTasks = useOcrStore((state) => state.submitTasks);
  const queueAllOcr = useOcrStore((state) => state.queueAllOcr);
  const engineAvailable = engine === 'rapid'
    ? Boolean(rapidStatus?.available)
    : engine === 'mineru'
      ? Boolean(health?.connected)
      : engine === 'windows'
        ? Boolean(windowsStatus?.available)
        : Boolean(paddleStatus?.available);

  // Load settings and health on mount
  useEffect(() => {
    void loadSettings().then(() => {
      void checkHealth();
    });
    void loadCandidates();
  }, [checkHealth, loadCandidates, loadSettings]);

  return (
    <div className="flex flex-col h-full relative">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
            {t('nav.ocr')}
          </h2>
          {/* Health indicator */}
          <div role="status" aria-live="polite">
            <HealthBadge />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { void checkHealth(); void loadCandidates(); }}
            className="btn-ghost p-1.5 rounded-lg"
            title={t('common.refresh')}
            aria-label={t('common.refresh')}
          >
            <RefreshCw size={16} className={healthChecking ? 'animate-spin' : ''} />
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
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                {t('ocr.pendingFiles')}
              </h3>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button type="button" onClick={selectAll} className="btn-ghost text-xs px-2 py-1 rounded">
                  {t('ocr.selectAll')}
                </button>
                <button type="button" onClick={deselectAll} className="btn-ghost text-xs px-2 py-1 rounded">
                  {t('ocr.deselectAll')}
                </button>
                {totalCandidates > 0 && (
                  <button
                    type="button"
                    onClick={() => void queueAllOcr()}
                    disabled={!engineAvailable || bulkOcrRunning}
                    className="btn-secondary inline-flex h-8 items-center gap-1.5 px-2.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {bulkOcrRunning ? <Loader2 size={14} className="animate-spin" /> : <ScanText size={14} />}
                    {bulkOcrRunning
                      ? t('ocr.allProgress', { count: bulkOcrQueued })
                      : t('ocr.startAll', { count: totalCandidates })}
                  </button>
                )}
                {candidates.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void submitTasks()}
                    disabled={
                      selectedFileIds.size === 0 ||
                      !engineAvailable ||
                      isSubmitting
                    }
                    className="btn-primary px-4 py-2 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ScanText size={16} className="inline mr-1.5" />
                    {t('ocr.start', { count: selectedFileIds.size })}
                  </button>
                )}
              </div>
            </div>

            {loadingCandidates ? (
              <div className="flex items-center justify-center py-8 text-surface-400">
                <Loader2 size={20} className="animate-spin mr-2" />
                {t('ocr.loadingFiles')}
              </div>
            ) : candidates.length === 0 ? (
              <div className="text-center py-8 text-surface-400">
                <FileText size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">{t('ocr.noPendingFiles')}</p>
                <p className="text-xs mt-1">{t('ocr.noPendingFilesHint')}</p>
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
  const engine = useOcrStore((s) => s.engine);
  const windowsStatus = useOcrStore((s) => s.windowsStatus);
  const paddleStatus = useOcrStore((s) => s.paddleStatus);
  const rapidStatus = useOcrStore((s) => s.rapidStatus);

  if (healthChecking) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-surface-400">
        <Loader2 size={12} className="animate-spin" />
        {t('ocr.checking')}
      </span>
    );
  }
  if (engine === 'rapid') {
    if (rapidStatus?.available) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-green-600" title={`${rapidStatus.rapidocr_version ?? ''} / ${rapidStatus.active_provider ?? 'unknown'}`}>
          <Zap size={12} />
          {t('ocr.rapidReady')} · {rapidStatus.accelerated ? t('ocr.rapidAccelerated') : t('ocr.rapidCpu')}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-500" title={rapidStatus?.error || undefined}>
        <WifiOff size={12} />
        {t('ocr.rapidUnavailable')}
      </span>
    );
  }
  if (engine === 'windows') {
    if (windowsStatus?.available) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
          <Monitor size={12} />
          {t('ocr.windowsReady')}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-500" title={windowsStatus?.error || undefined}>
        <WifiOff size={12} />
        {t('ocr.windowsUnavailable')}
      </span>
    );
  }
  if (engine === 'paddle') {
    if (paddleStatus?.available) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-green-600" title={`Paddle ${paddleStatus.paddle_version ?? ''} / PaddleOCR ${paddleStatus.paddleocr_version ?? ''} / ${paddleStatus.active_device ?? 'unknown'}`}>
          <Boxes size={12} />
          {t('ocr.paddleReady')} · {paddleStatus.active_device === 'gpu:0' ? t('ocr.paddleDeviceCuda') : t('ocr.paddleDeviceCpu')}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-500" title={paddleStatus?.error || undefined}>
        <WifiOff size={12} />
        {t('ocr.paddleUnavailable')}
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
  const engine = useOcrStore((s) => s.engine);
  const windowsStatus = useOcrStore((s) => s.windowsStatus);
  const windowsLanguage = useOcrStore((s) => s.windowsLanguage);
  const paddleStatus = useOcrStore((s) => s.paddleStatus);
  const rapidStatus = useOcrStore((s) => s.rapidStatus);
  const rapidInstallProgress = useOcrStore((s) => s.rapidInstallProgress);
  const isInstallingRapid = useOcrStore((s) => s.isInstallingRapid);
  const rapidLanguage = useOcrStore((s) => s.rapidLanguage);
  const rapidDeviceMode = useOcrStore((s) => s.rapidDeviceMode);
  const rapidWorkerCount = useOcrStore((s) => s.rapidWorkerCount);
  const paddleInstallProgress = useOcrStore((s) => s.paddleInstallProgress);
  const isInstallingPaddle = useOcrStore((s) => s.isInstallingPaddle);
  const paddleLanguage = useOcrStore((s) => s.paddleLanguage);
  const paddleModel = useOcrStore((s) => s.paddleModel);
  const paddleDeviceMode = useOcrStore((s) => s.paddleDeviceMode);
  const paddlePypiPrimary = useOcrStore((s) => s.paddlePypiPrimary);
  const paddlePypiFallback = useOcrStore((s) => s.paddlePypiFallback);
  const saveEngine = useOcrStore((s) => s.saveEngine);
  const saveWindowsLanguage = useOcrStore((s) => s.saveWindowsLanguage);
  const savePaddleLanguage = useOcrStore((s) => s.savePaddleLanguage);
  const savePaddleModel = useOcrStore((s) => s.savePaddleModel);
  const savePaddleDeviceMode = useOcrStore((s) => s.savePaddleDeviceMode);
  const savePaddlePypiPrimary = useOcrStore((s) => s.savePaddlePypiPrimary);
  const savePaddlePypiFallback = useOcrStore((s) => s.savePaddlePypiFallback);
  const installPaddle = useOcrStore((s) => s.installPaddle);
  const saveRapidLanguage = useOcrStore((s) => s.saveRapidLanguage);
  const saveRapidDeviceMode = useOcrStore((s) => s.saveRapidDeviceMode);
  const saveRapidWorkerCount = useOcrStore((s) => s.saveRapidWorkerCount);
  const installRapid = useOcrStore((s) => s.installRapid);
  const healthChecking = useOcrStore((s) => s.healthChecking);
  const [apiUrlDraft, setApiUrlDraft] = useState(apiUrl);
  const [outputDirDraft, setOutputDirDraft] = useState(outputDir);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => setApiUrlDraft(apiUrl), [apiUrl]);
  useEffect(() => setOutputDirDraft(outputDir), [outputDir]);

  const saveDraft = async (save: (value: string) => Promise<void>, value: string) => {
    setSaveState('saving');
    try {
      await save(value);
      setSaveState('saved');
    } catch (error) {
      console.error('Failed to save OCR setting:', error);
      setSaveState('error');
    }
  };

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center gap-3">
        <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">
          {t('ocr.settings')}
        </h3>
        <span className={`ml-auto text-xs ${saveState === 'error' ? 'text-red-500' : 'text-surface-400'}`} role="status" aria-live="polite">
          {saveState === 'saving' ? t('settings.saving') : saveState === 'saved' ? t('settings.saved') : saveState === 'error' ? t('settings.saveFailed') : ''}
        </span>
      </div>
      <div className="space-y-4">
        <div>
          <span className="block text-xs text-surface-500 mb-1.5">
            {t('ocr.engine')}
          </span>
          <div className="inline-flex rounded-md border border-surface-200 bg-surface-50 p-0.5 dark:border-surface-700 dark:bg-surface-900">
            <button
              type="button"
              onClick={() => saveEngine('rapid')}
              aria-pressed={engine === 'rapid'}
              className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors ${engine === 'rapid' ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-700 dark:text-surface-100' : 'text-surface-500 hover:text-surface-800 dark:hover:text-surface-200'}`}
            >
              <Zap size={14} /> RapidOCR
            </button>
            <button
              type="button"
              onClick={() => saveEngine('mineru')}
              aria-pressed={engine === 'mineru'}
              className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors ${engine === 'mineru' ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-700 dark:text-surface-100' : 'text-surface-500 hover:text-surface-800 dark:hover:text-surface-200'}`}
            >
              <Server size={14} /> MinerU
            </button>
            <button
              type="button"
              onClick={() => saveEngine('windows')}
              aria-pressed={engine === 'windows'}
              className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors ${engine === 'windows' ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-700 dark:text-surface-100' : 'text-surface-500 hover:text-surface-800 dark:hover:text-surface-200'}`}
            >
              <Monitor size={14} /> {t('ocr.windowsEngine')}
            </button>
            <button
              type="button"
              onClick={() => saveEngine('paddle')}
              aria-pressed={engine === 'paddle'}
              className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors ${engine === 'paddle' ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-700 dark:text-surface-100' : 'text-surface-500 hover:text-surface-800 dark:hover:text-surface-200'}`}
            >
              <Boxes size={14} /> PaddleOCR
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {engine === 'rapid' ? <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor="ocr-rapid-language" className="mb-1 block text-xs text-surface-500">{t('ocr.rapidLanguage')}</label>
              <select id="ocr-rapid-language" name="rapidocr_language" className="input text-sm" value={rapidLanguage} onChange={(event) => void saveRapidLanguage(event.target.value)}>
                <option value="ch">中文</option>
                <option value="en">English</option>
                <option value="japan">日本語</option>
                <option value="korean">한국어</option>
              </select>
            </div>
            <div>
              <label htmlFor="ocr-rapid-workers" className="mb-1 block text-xs text-surface-500">{t('ocr.rapidWorkers')}</label>
              <input
                id="ocr-rapid-workers"
                name="rapidocr_worker_count"
                type="number"
                min={1}
                max={MAX_RAPID_OCR_WORKERS}
                step={1}
                className="input text-sm"
                value={rapidWorkerCount}
                onChange={(event) => void saveRapidWorkerCount(event.currentTarget.valueAsNumber)}
              />
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs text-surface-500">{t('ocr.rapidDevice')}</span>
            <RapidDeviceModeControl value={rapidDeviceMode} onChange={(value) => void saveRapidDeviceMode(value)} disabled={healthChecking || isInstallingRapid} t={t} />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" className="btn-secondary flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-xs disabled:opacity-50" onClick={() => void installRapid()} disabled={healthChecking || isInstallingRapid || rapidStatus?.install_supported === false}>
              {isInstallingRapid ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {t('ocr.installRapid')}
            </button>
            {!isInstallingRapid && rapidStatus && (
              <span className={`min-w-0 truncate text-xs ${rapidStatus.available ? 'text-green-600' : 'text-red-500'}`} title={rapidStatus.error ?? undefined}>
                {rapidStatus.available ? rapidRuntimeLabel(rapidStatus, t) : rapidStatus.error}
              </span>
            )}
          </div>
          {!isInstallingRapid && rapidStatus?.fallback_reason && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{rapidStatus.fallback_reason}</p>
          )}
          {isInstallingRapid && rapidInstallProgress && (
            <div className="space-y-1.5" role="status" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-xs text-surface-500">
                <span>{t(rapidInstallStageLabels[rapidInstallProgress.stage])}</span>
                <span className="font-mono tabular-nums">{rapidInstallProgress.progress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-sm bg-surface-200 dark:bg-surface-800">
                <div className="h-full bg-accent-500 transition-[width] duration-300" style={{ width: `${rapidInstallProgress.progress}%` }} />
              </div>
              {rapidInstallProgress.message && <p className="truncate text-[11px] text-surface-400" title={rapidInstallProgress.message}>{rapidInstallProgress.message}</p>}
            </div>
          )}
        </div> : engine === 'mineru' ? <div>
          <label htmlFor="ocr-api-url" className="block text-xs text-surface-500 mb-1">
            {t('ocr.apiUrl')}
          </label>
          <input
            id="ocr-api-url"
            name="ocr_api_url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="input text-sm"
            value={apiUrlDraft}
            onChange={(e) => setApiUrlDraft(e.target.value)}
            onBlur={() => { if (apiUrlDraft !== apiUrl) void saveDraft(saveApiUrl, apiUrlDraft); }}
            placeholder="http://127.0.0.1:8000…"
          />
        </div> : engine === 'windows' ? <div>
          <label htmlFor="ocr-windows-language" className="block text-xs text-surface-500 mb-1">
            {t('ocr.windowsLanguage')}
          </label>
          <select
            id="ocr-windows-language"
            name="windows_ocr_language"
            className="input text-sm"
            value={windowsLanguage}
            onChange={(event) => saveWindowsLanguage(event.target.value)}
            disabled={!windowsStatus?.available}
          >
            <option value="auto">{t('ocr.languageAuto')}</option>
            {windowsStatus?.languages.map((language) => (
              <option key={language.tag} value={language.tag}>
                {language.native_name} ({language.tag})
              </option>
            ))}
          </select>
          {windowsStatus?.error && <p className="mt-1 text-xs text-red-500">{windowsStatus.error}</p>}
        </div> : <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="ocr-paddle-language" className="block text-xs text-surface-500 mb-1">{t('ocr.paddleLanguage')}</label>
              <select id="ocr-paddle-language" name="paddle_ocr_language" className="input text-sm" value={paddleLanguage} onChange={(event) => void savePaddleLanguage(event.target.value)}>
                <option value="ch">中文</option>
                <option value="en">English</option>
                <option value="japan">日本語</option>
                <option value="korean">한국어</option>
              </select>
            </div>
            <div>
              <label htmlFor="ocr-paddle-model" className="block text-xs text-surface-500 mb-1">{t('ocr.paddleModel')}</label>
              <select id="ocr-paddle-model" name="paddle_ocr_model" className="input text-sm" value={paddleModel} onChange={(event) => void savePaddleModel(event.target.value)}>
                <option value="PP-OCRv5_mobile">PP-OCRv5 Mobile</option>
                <option value="PP-OCRv5_server">PP-OCRv5 Server</option>
              </select>
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs text-surface-500">{t('ocr.paddleDevice')}</span>
            <PaddleDeviceModeControl
              value={paddleDeviceMode}
              onChange={(value) => void savePaddleDeviceMode(value)}
              disabled={healthChecking || isInstallingPaddle}
              t={t}
            />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor="ocr-paddle-pypi-primary" className="mb-1 block text-xs text-surface-500">{t('ocr.paddlePypiPrimary')}</label>
              <select id="ocr-paddle-pypi-primary" name="paddle_pypi_primary" className="input text-sm" value={paddlePypiPrimary} onChange={(event) => void savePaddlePypiPrimary(event.target.value as PaddlePackageIndex)}>
                <PaddlePackageIndexOptions t={t} />
              </select>
            </div>
            <div>
              <label htmlFor="ocr-paddle-pypi-fallback" className="mb-1 block text-xs text-surface-500">{t('ocr.paddlePypiFallback')}</label>
              <select id="ocr-paddle-pypi-fallback" name="paddle_pypi_fallback" className="input text-sm" value={paddlePypiFallback} onChange={(event) => void savePaddlePypiFallback(event.target.value as PaddlePackageIndex)}>
                <PaddlePackageIndexOptions t={t} />
              </select>
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" className="btn-secondary flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-xs disabled:opacity-50" onClick={() => void installPaddle()} disabled={healthChecking || isInstallingPaddle || paddleStatus?.install_supported === false || (paddleDeviceMode === 'cuda12' && paddleStatus?.gpu_compatible === false)}>
              {isInstallingPaddle ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {t('ocr.installPaddle')}
            </button>
            {!isInstallingPaddle && paddleStatus && (
              <span className={`min-w-0 truncate text-xs ${paddleStatus.available ? 'text-green-600' : 'text-red-500'}`} title={paddleStatus.error ?? undefined}>
                {paddleStatus.available ? paddleRuntimeLabel(paddleStatus, t) : paddleStatus.error}
              </span>
            )}
          </div>
          {!isInstallingPaddle && paddleStatus?.fallback_reason && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{paddleStatus.fallback_reason}</p>
          )}
          {!isInstallingPaddle && paddleStatus?.gpu_detected && (
            <p className="text-[11px] text-surface-400">
              {[paddleStatus.gpu_name, paddleStatus.gpu_compute_capability ? `CC ${paddleStatus.gpu_compute_capability}` : null, paddleStatus.gpu_driver_version ? `${t('ocr.paddleDriver')} ${paddleStatus.gpu_driver_version}` : null].filter(Boolean).join(' · ')}
            </p>
          )}
          {isInstallingPaddle && paddleInstallProgress && (
            <div className="space-y-1.5" role="status" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-xs text-surface-500">
                <span>{t(paddleInstallStageLabels[paddleInstallProgress.stage])}</span>
                <span className="font-mono tabular-nums">{paddleInstallProgress.progress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-sm bg-surface-200 dark:bg-surface-800">
                <div className="h-full bg-accent-500 transition-[width] duration-300" style={{ width: `${paddleInstallProgress.progress}%` }} />
              </div>
              {paddleInstallProgress.message && (
                <p className="truncate text-[11px] text-surface-400" title={paddleInstallProgress.message}>{paddleInstallProgress.message}</p>
              )}
            </div>
          )}
        </div>}
        <div>
          <label htmlFor="ocr-output-directory" className="block text-xs text-surface-500 mb-1">
            {t('ocr.outputDirectory')}
          </label>
          <input
            id="ocr-output-directory"
            name="ocr_output_directory"
            type="text"
            autoComplete="off"
            spellCheck={false}
            className="input text-sm"
            value={outputDirDraft}
            onChange={(e) => setOutputDirDraft(e.target.value)}
            onBlur={() => { if (outputDirDraft !== outputDir) void saveDraft(saveOutputDir, outputDirDraft); }}
            placeholder={`${t('ocr.outputPlaceholder', { project: '{project}' })}…`}
          />
        </div>
        </div>
      </div>
    </div>
  );
}

function PaddlePackageIndexOptions({ t }: { t: ReturnType<typeof useI18n>['t'] }) {
  return (
    <>
      <option value="ustc">{t('ocr.paddlePypiUstc')}</option>
      <option value="tsinghua">{t('ocr.paddlePypiTsinghua')}</option>
      <option value="official">{t('ocr.paddlePypiOfficial')}</option>
    </>
  );
}

function PaddleDeviceModeControl({ value, onChange, disabled, t }: {
  value: PaddleDeviceMode;
  onChange: (value: PaddleDeviceMode) => void;
  disabled: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const options: Array<{ value: PaddleDeviceMode; label: string }> = [
    { value: 'auto', label: t('ocr.paddleDeviceAuto') },
    { value: 'cpu', label: t('ocr.paddleDeviceCpu') },
    { value: 'cuda12', label: t('ocr.paddleDeviceCuda') },
  ];
  return (
    <div className="inline-flex rounded-md border border-surface-200 bg-surface-50 p-0.5 dark:border-surface-700 dark:bg-surface-900" role="group" aria-label={t('ocr.paddleDevice')}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`h-7 rounded px-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${value === option.value ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-700 dark:text-surface-100' : 'text-surface-500 hover:text-surface-800 dark:hover:text-surface-200'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function RapidDeviceModeControl({ value, onChange, disabled, t }: {
  value: RapidDeviceMode;
  onChange: (value: RapidDeviceMode) => void;
  disabled: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const options: Array<{ value: RapidDeviceMode; label: string }> = [
    { value: 'auto', label: t('ocr.rapidDeviceAuto') },
    { value: 'cpu', label: t('ocr.rapidDeviceCpu') },
  ];
  return (
    <div className="inline-flex rounded-md border border-surface-200 bg-surface-50 p-0.5 dark:border-surface-700 dark:bg-surface-900" role="group" aria-label={t('ocr.rapidDevice')}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} disabled={disabled} onClick={() => onChange(option.value)} className={`h-7 rounded px-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${value === option.value ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-700 dark:text-surface-100' : 'text-surface-500 hover:text-surface-800 dark:hover:text-surface-200'}`}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function rapidRuntimeLabel(status: RapidOcrStatus, t: ReturnType<typeof useI18n>['t']) {
  const mode = status.accelerated ? t('ocr.rapidAccelerated') : t('ocr.rapidCpu');
  return `RapidOCR ${status.rapidocr_version ?? ''} · ${mode} · ${status.active_provider ?? '?'}`;
}

function paddleRuntimeLabel(status: PaddleOcrStatus, t: ReturnType<typeof useI18n>['t']) {
  const device = status.active_device === 'gpu:0'
    ? `${t('ocr.paddleDeviceCuda')}${status.cuda_version ? ` (${status.cuda_version})` : ''}`
    : t('ocr.paddleDeviceCpu');
  return `PaddleOCR ${status.paddleocr_version ?? ''} · ${device}`;
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
                  className={`border-b border-surface-100 dark:border-surface-900 cursor-pointer transition-colors hover:bg-surface-50 dark:hover:bg-surface-900 ${
                    isSelected ? 'bg-accent-50 dark:bg-accent-950/30' : ''
                  }`}
                >
                  <td>
                    <label className="flex cursor-pointer items-center py-2 pr-2" aria-label={`${t('common.select')}: ${file.file_name}`}>
                      <input
                        id={`ocr-file-${file.id}`}
                        type="checkbox"
                        name="ocr_file"
                        value={file.id}
                        checked={isSelected}
                        onChange={() => toggleFile(file.id)}
                        className="rounded"
                      />
                    </label>
                  </td>
                  <td className="max-w-64 text-surface-700 dark:text-surface-300">
                    <label htmlFor={`ocr-file-${file.id}`} className="block cursor-pointer truncate py-2">{file.file_name}</label>
                  </td>
                  <td className="text-xs text-surface-500">
                    <label htmlFor={`ocr-file-${file.id}`} className="block cursor-pointer py-2">{getFolderPath(file.folder_id)}</label>
                  </td>
                  <td className="text-right text-xs text-surface-500 tabular-nums">
                    <label htmlFor={`ocr-file-${file.id}`} className="block cursor-pointer py-2">{formatFileSize(file.file_size_bytes)}</label>
                  </td>
                  <td className="text-right">
                    <label htmlFor={`ocr-file-${file.id}`} className="block cursor-pointer py-2">
                      {file.ocr_applied ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-600">
                          <CheckCircle size={12} aria-hidden="true" /> {t('ocr.done')}
                        </span>
                      ) : (
                        <span className="text-xs text-surface-400">-</span>
                      )}
                    </label>
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
