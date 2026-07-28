import { useState, useEffect, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Wifi, Loader2, CheckCircle, XCircle, Save, Trash2, Monitor, Server, Boxes, Download } from 'lucide-react';
import { getSetting, setSetting, checkOcrHealth, getWindowsOcrStatus, getPaddleOcrStatus, installPaddleOcr, vacuumDatabase, getOpenAiConfig, setOpenAiConfig, testOpenAiConnection, getSearchBackendStatus } from '../../lib/tauri';
import { useUIStore } from '../../stores/uiStore';
import type { MinerUHealthInfo, OcrEngine, PaddleInstallProgress, PaddleOcrStatus, SearchBackendStatus, WindowsOcrStatus } from '../../types';
import { useI18n } from '../../lib/i18n';
import type { Language } from '../../stores/uiStore';

const paddleInstallStageLabels = {
  preparing: 'ocr.paddleStagePreparing',
  extracting: 'ocr.paddleStageExtracting',
  installing: 'ocr.paddleStageInstalling',
  verifying: 'ocr.paddleStageVerifying',
  completed: 'ocr.paddleStageCompleted',
  failed: 'ocr.paddleStageFailed',
} as const;

export function SettingsPanel() {
  const { t } = useI18n();
  // ── State ──
  const [maxFileSizeMb, setMaxFileSizeMb] = useState('500');
  const [ocrApiUrl, setOcrApiUrl] = useState('http://127.0.0.1:8000');
  const [ocrOutputDir, setOcrOutputDir] = useState('');
  const [ocrEngine, setOcrEngine] = useState<OcrEngine>('mineru');
  const [windowsOcrLanguage, setWindowsOcrLanguage] = useState('auto');
  const [windowsOcrStatus, setWindowsOcrStatus] = useState<WindowsOcrStatus | null>(null);
  const [paddleLanguage, setPaddleLanguage] = useState('ch');
  const [paddleModel, setPaddleModel] = useState('PP-OCRv5_mobile');
  const [paddleStatus, setPaddleStatus] = useState<PaddleOcrStatus | null>(null);
  const [paddleInstallProgress, setPaddleInstallProgress] = useState<PaddleInstallProgress | null>(null);
  const [paddleInstalling, setPaddleInstalling] = useState(false);
  const [ocrHealth, setOcrHealth] = useState<MinerUHealthInfo | null>(null);
  const [ocrChecking, setOcrChecking] = useState(false);
  const [openAiEndpoint, setOpenAiEndpoint] = useState('https://api.openai.com/v1');
  const [openAiModel, setOpenAiModel] = useState('gpt-4.1-mini');
  const [openAiApiKey, setOpenAiApiKey] = useState('');
  const [openAiKeyConfigured, setOpenAiKeyConfigured] = useState(false);
  const [smartSearchEnabled, setSmartSearchEnabled] = useState(true);
  const [openAiChecking, setOpenAiChecking] = useState(false);
  const [openAiConnection, setOpenAiConnection] = useState<{ connected: boolean; message: string } | null>(null);
  const [searchBackend, setSearchBackend] = useState<SearchBackendStatus | null>(null);
  const [vacuumResult, setVacuumResult] = useState('');
  const [vacuuming, setVacuuming] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);

  // ── Load settings on mount ──
  useEffect(() => {
    (async () => {
      const keys = [
        'max_file_size_mb', 'ocr_api_url', 'ocr_output_dir', 'ocr_engine', 'windows_ocr_language',
        'paddle_ocr_language', 'paddle_ocr_model'
      ];
      for (const key of keys) {
        const val = await getSetting(key);
        if (val != null) {
          switch (key) {
            case 'max_file_size_mb': setMaxFileSizeMb(val); break;
            case 'ocr_api_url': setOcrApiUrl(val); break;
            case 'ocr_output_dir': setOcrOutputDir(val); break;
            case 'ocr_engine': setOcrEngine(val === 'windows' || val === 'paddle' ? val : 'mineru'); break;
            case 'windows_ocr_language': setWindowsOcrLanguage(val); break;
            case 'paddle_ocr_language': setPaddleLanguage(val); break;
            case 'paddle_ocr_model': setPaddleModel(val); break;
          }
        }
      }
      const openAi = await getOpenAiConfig();
      setOpenAiEndpoint(openAi.endpoint);
      setOpenAiModel(openAi.model);
      setOpenAiKeyConfigured(openAi.api_key_configured);
      setSmartSearchEnabled(openAi.smart_search_enabled);
    })();
  }, []);

  useEffect(() => {
    const unlisten = listen<PaddleInstallProgress>('paddle-install:progress', (event) => {
      setPaddleInstallProgress(event.payload);
      setPaddleInstalling(event.payload.stage !== 'completed' && event.payload.stage !== 'failed');
    });
    return () => { unlisten.then((stop) => stop()); };
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const status = await getSearchBackendStatus();
        if (active) setSearchBackend(status);
      } catch {
        // The desktop backend may be unavailable in browser-only development.
      }
    };
    void refresh();
    const interval = window.setInterval(refresh, 2000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (ocrEngine !== 'windows' || windowsOcrStatus) return;
    let active = true;
    getWindowsOcrStatus()
      .then((status) => { if (active) setWindowsOcrStatus(status); })
      .catch((error) => {
        if (active) setWindowsOcrStatus({ available: false, languages: [], error: String(error) });
      });
    return () => { active = false; };
  }, [ocrEngine, windowsOcrStatus]);

  useEffect(() => {
    if (ocrEngine !== 'paddle') return;
    let active = true;
    getPaddleOcrStatus()
      .then((status) => { if (active) setPaddleStatus(status); })
      .catch((error) => {
        if (active) {
          setPaddleStatus(failedPaddleStatus(error));
        }
      });
    return () => { active = false; };
  }, [ocrEngine]);

  // ── Save helpers ──
  const save = useCallback(async (key: string, value: string) => {
    setSaveState('saving');
    try {
      await setSetting(key, value);
      setSaveState('saved');
    } catch (e) {
      console.error(`Failed to save ${key}:`, e);
      setSaveState('error');
    }
  }, []);

  // ── Health check ──
  const checkHealth = async () => {
    setOcrChecking(true);
    if (ocrEngine === 'windows') {
      try {
        setWindowsOcrStatus(await getWindowsOcrStatus());
      } catch (error) {
        setWindowsOcrStatus({ available: false, languages: [], error: String(error) });
      }
      setOcrChecking(false);
      return;
    }
    if (ocrEngine === 'paddle') {
      try {
        setPaddleStatus(await getPaddleOcrStatus());
      } catch (error) {
        setPaddleStatus(failedPaddleStatus(error));
      }
      setOcrChecking(false);
      return;
    }
    try {
      const result = await checkOcrHealth();
      setOcrHealth(result);
    } catch {
      setOcrHealth({
        protocol_version: '',
        processing_window_size: 0,
        max_concurrent_requests: 0,
        connected: false,
        api_url: ocrApiUrl,
      });
    }
    setOcrChecking(false);
  };

  const installPaddle = async () => {
    if (paddleInstalling) return;
    setPaddleInstalling(true);
    setPaddleInstallProgress({ stage: 'preparing', progress: 0, message: '' });
    try {
      const status = await installPaddleOcr();
      setPaddleStatus(status);
    } catch (error) {
      setPaddleStatus(failedPaddleStatus(error));
      setPaddleInstallProgress({ stage: 'failed', progress: 100, message: String(error) });
    } finally {
      setPaddleInstalling(false);
    }
  };

  const saveOpenAi = async (apiKey: string | undefined = openAiApiKey || undefined) => {
    setSaveState('saving');
    try {
      const config = await setOpenAiConfig(openAiEndpoint, openAiModel, apiKey, smartSearchEnabled);
      setOpenAiKeyConfigured(config.api_key_configured);
      setOpenAiApiKey('');
      setSaveState('saved');
      return config;
    } catch (error) {
      setSaveState('error');
      throw error;
    }
  };

  const checkOpenAi = async () => {
    setOpenAiChecking(true);
    setOpenAiConnection(null);
    try {
      await saveOpenAi();
      setOpenAiConnection(await testOpenAiConnection());
    } catch (error) {
      setOpenAiConnection({ connected: false, message: String(error) });
    } finally {
      setOpenAiChecking(false);
    }
  };

  // ── Vacuum ──
  const runVacuum = async () => {
    setVacuuming(true);
    setVacuumResult('');
    try {
      const result = await vacuumDatabase();
      const match = result.match(/^VACUUM complete: (.+?) → (.+?) \(saved (.+?)\)$/);
      setVacuumResult(match
        ? t('settings.vacuumResult', { before: match[1], after: match[2], saved: match[3] })
        : t('settings.vacuumComplete'));
    } catch (e: any) {
      setVacuumResult(t('settings.vacuumError', { error: String(e) }));
    }
    setVacuuming(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center px-4 h-12 border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950">
        <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
          {t('settings.title')}
        </h2>
        <span className={`ml-auto text-xs ${saveState === 'error' ? 'text-red-500' : 'text-surface-400'}`} role="status" aria-live="polite">
          {saveState === 'saving' ? t('settings.saving') : saveState === 'saved' ? t('settings.saved') : saveState === 'error' ? t('settings.saveFailed') : ''}
        </span>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-2xl space-y-6">
          {/* ── Index Settings ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              {t('settings.index')}
            </h3>
            <div className="space-y-4">
              <div>
                <label htmlFor="setting-max-file-size" className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.maxFileSize')}
                </label>
                <input
                  id="setting-max-file-size"
                  name="max_file_size_mb"
                  type="number"
                  inputMode="numeric"
                  className="input w-32"
                  value={maxFileSizeMb}
                  min={1}
                  onChange={(e) => setMaxFileSizeMb(e.target.value)}
                  onBlur={() => void save('max_file_size_mb', maxFileSizeMb)}
                />
              </div>
            </div>
          </div>

          {/* ── OCR (MinerU API) Settings ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              {t('ocr.settings')}
            </h3>
            <div className="space-y-4">
              <div>
                <span className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('ocr.engine')}
                </span>
                <div className="inline-flex rounded-md border border-surface-200 bg-surface-50 p-0.5 dark:border-surface-700 dark:bg-surface-900">
                  <button type="button" aria-pressed={ocrEngine === 'mineru'} onClick={() => { setOcrEngine('mineru'); save('ocr_engine', 'mineru'); setOcrHealth(null); }} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${ocrEngine === 'mineru' ? 'bg-white shadow-sm dark:bg-surface-700' : 'text-surface-500'}`}>
                    <Server size={14} /> MinerU
                  </button>
                  <button type="button" aria-pressed={ocrEngine === 'windows'} onClick={() => { setOcrEngine('windows'); save('ocr_engine', 'windows'); setWindowsOcrStatus(null); }} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${ocrEngine === 'windows' ? 'bg-white shadow-sm dark:bg-surface-700' : 'text-surface-500'}`}>
                    <Monitor size={14} /> {t('ocr.windowsEngine')}
                  </button>
                  <button type="button" aria-pressed={ocrEngine === 'paddle'} onClick={() => { setOcrEngine('paddle'); save('ocr_engine', 'paddle'); setPaddleStatus(null); }} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${ocrEngine === 'paddle' ? 'bg-white shadow-sm dark:bg-surface-700' : 'text-surface-500'}`}>
                    <Boxes size={14} /> PaddleOCR
                  </button>
                </div>
              </div>
              {ocrEngine === 'mineru' ? <div>
                <label htmlFor="setting-ocr-api-url" className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.ocrApiUrl')}
                </label>
                <input
                  id="setting-ocr-api-url"
                  name="ocr_api_url"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className="input"
                  value={ocrApiUrl}
                  onChange={(e) => setOcrApiUrl(e.target.value)}
                  onBlur={() => void save('ocr_api_url', ocrApiUrl)}
                  placeholder="http://127.0.0.1:8000…"
                />
              </div> : ocrEngine === 'windows' ? <div>
                <label htmlFor="setting-windows-ocr-language" className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('ocr.windowsLanguage')}
                </label>
                <select id="setting-windows-ocr-language" name="windows_ocr_language" className="input" value={windowsOcrLanguage} disabled={!windowsOcrStatus?.available} onChange={(event) => { setWindowsOcrLanguage(event.target.value); save('windows_ocr_language', event.target.value); }}>
                  <option value="auto">{t('ocr.languageAuto')}</option>
                  {windowsOcrStatus?.languages.map((item) => <option key={item.tag} value={item.tag}>{item.native_name} ({item.tag})</option>)}
                </select>
                {windowsOcrStatus?.error && <p className="mt-1 text-xs text-red-500">{windowsOcrStatus.error}</p>}
              </div> : <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="setting-paddle-language" className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">{t('ocr.paddleLanguage')}</label>
                    <select id="setting-paddle-language" name="paddle_ocr_language" className="input" value={paddleLanguage} onChange={(event) => { setPaddleLanguage(event.target.value); save('paddle_ocr_language', event.target.value); }}>
                      <option value="ch">中文</option>
                      <option value="en">English</option>
                      <option value="japan">日本語</option>
                      <option value="korean">한국어</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="setting-paddle-model" className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">{t('ocr.paddleModel')}</label>
                    <select id="setting-paddle-model" name="paddle_ocr_model" className="input" value={paddleModel} onChange={(event) => { setPaddleModel(event.target.value); save('paddle_ocr_model', event.target.value); }}>
                      <option value="PP-OCRv5_mobile">PP-OCRv5 Mobile</option>
                      <option value="PP-OCRv5_server">PP-OCRv5 Server</option>
                    </select>
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <button type="button" className="btn-secondary inline-flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-xs disabled:opacity-50" onClick={() => void installPaddle()} disabled={ocrChecking || paddleInstalling || paddleStatus?.install_supported === false}>
                    {paddleInstalling ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                    {t('ocr.installPaddle')}
                  </button>
                  {!paddleInstalling && paddleStatus && (
                    <p className={`min-w-0 truncate text-xs ${paddleStatus.available ? 'text-green-600' : 'text-red-500'}`} title={paddleStatus.error ?? undefined}>
                      {paddleStatus.available ? `PaddleOCR ${paddleStatus.paddleocr_version ?? ''}` : paddleStatus.error}
                    </p>
                  )}
                </div>
                {paddleInstalling && paddleInstallProgress && (
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
                <label htmlFor="setting-ocr-output" className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.ocrOutput')}
                </label>
                <input
                  id="setting-ocr-output"
                  name="ocr_output_directory"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  className="input"
                  value={ocrOutputDir}
                  onChange={(e) => setOcrOutputDir(e.target.value)}
                  onBlur={() => void save('ocr_output_dir', ocrOutputDir)}
                  placeholder={`${t('ocr.outputPlaceholder', { project: '{project}' })}…`}
                />
                <p className="text-xs text-surface-400 mt-1">
                  {t('settings.ocrOutputHint')}
                </p>
              </div>

              {/* Health check */}
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={checkHealth}
                  disabled={ocrChecking}
                  className="btn-secondary px-3 py-1.5 rounded-lg text-sm disabled:opacity-50"
                >
                  {ocrChecking ? (
                    <Loader2 size={14} className="animate-spin inline mr-1.5" />
                  ) : (
                    <Wifi size={14} className="inline mr-1.5" />
                  )}
                  {t('settings.testConnection')}
                </button>
                {ocrEngine === 'mineru' && ocrHealth && (
                  <span role="status" aria-live="polite" className={`text-xs inline-flex items-center gap-1 ${ocrHealth.connected ? 'text-green-600' : 'text-red-500'}`}>
                    {ocrHealth.connected ? (
                      <>
                        <CheckCircle size={12} />
                        {t('settings.connected', { version: ocrHealth.protocol_version || '?', count: ocrHealth.max_concurrent_requests })}
                      </>
                    ) : (
                      <>
                        <XCircle size={12} />
                        {t('settings.cannotConnect')}
                      </>
                    )}
                  </span>
                )}
                {ocrEngine === 'windows' && windowsOcrStatus && (
                  <span role="status" aria-live="polite" className={`text-xs inline-flex items-center gap-1 ${windowsOcrStatus.available ? 'text-green-600' : 'text-red-500'}`}>
                    {windowsOcrStatus.available ? <CheckCircle size={12} /> : <XCircle size={12} />}
                    {windowsOcrStatus.available ? t('ocr.windowsReady') : t('ocr.windowsUnavailable')}
                  </span>
                )}
                {ocrEngine === 'paddle' && paddleStatus && (
                  <span role="status" aria-live="polite" className={`text-xs inline-flex min-w-0 items-center gap-1 ${paddleStatus.available ? 'text-green-600' : 'text-red-500'}`} title={paddleStatus.error ?? undefined}>
                    {paddleStatus.available ? <CheckCircle size={12} /> : <XCircle size={12} />}
                    <span className="truncate">{paddleStatus.available ? t('ocr.paddleReady') : t('ocr.paddleUnavailable')}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              {t('settings.smartSearch')}
            </h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4 text-sm" role="status" aria-live="polite">
                <span className="text-surface-600 dark:text-surface-400">{t('settings.searchBackend')}</span>
                {searchBackend?.connected ? (
                  <span className="inline-flex items-center gap-1.5 text-green-600" title={searchBackend.endpoint ?? undefined}>
                    <CheckCircle size={13} />
                    {t('settings.elasticsearchReady', { version: searchBackend.version ?? '?' })}
                  </span>
                ) : searchBackend?.error ? (
                  <span className="inline-flex items-center gap-1.5 text-red-500 min-w-0" title={searchBackend.error}>
                    <XCircle size={13} className="shrink-0" />
                    <span className="truncate">{t('settings.elasticsearchFailed')}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-surface-500">
                    <Loader2 size={13} className="animate-spin" />
                    {t('settings.elasticsearchStarting')}
                  </span>
                )}
              </div>
              <label className="flex items-center justify-between gap-4 text-sm text-surface-600 dark:text-surface-400">
                <span>{t('settings.smartSearchEnabled')}</span>
                <input
                  name="smart_search_enabled"
                  type="checkbox"
                  checked={smartSearchEnabled}
                  onChange={(event) => setSmartSearchEnabled(event.target.checked)}
                  className="h-4 w-4 accent-accent-500"
                />
              </label>
              <div>
                <label htmlFor="setting-openai-endpoint" className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.openAiEndpoint')}
                </label>
                <input id="setting-openai-endpoint" name="openai_endpoint" type="url" inputMode="url" autoComplete="off" spellCheck={false} className="input" value={openAiEndpoint} onChange={(event) => setOpenAiEndpoint(event.target.value)} placeholder="https://api.openai.com/v1…" />
              </div>
              <div>
                <label htmlFor="setting-openai-model" className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.openAiModel')}
                </label>
                <input id="setting-openai-model" name="openai_model" autoComplete="off" spellCheck={false} className="input" value={openAiModel} onChange={(event) => setOpenAiModel(event.target.value)} placeholder="gpt-4.1-mini…" />
              </div>
              <div>
                <label htmlFor="setting-openai-key" className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.openAiApiKey')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="setting-openai-key"
                    name="openai_api_key"
                    type="password"
                    className="input flex-1"
                    value={openAiApiKey}
                    onChange={(event) => setOpenAiApiKey(event.target.value)}
                    placeholder={openAiKeyConfigured ? `${t('settings.apiKeySaved')}…` : 'sk-…'}
                    autoComplete="off"
                  />
                  {openAiKeyConfigured && (
                    <button
                      type="button"
                      className="btn-ghost p-2 rounded-lg"
                      title={t('settings.removeApiKey')}
                      aria-label={t('settings.removeApiKey')}
                      onClick={() => void saveOpenAi('')}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button type="button" className="btn-secondary px-3 py-1.5 rounded-lg text-sm" onClick={() => void saveOpenAi()}>
                  <Save size={14} className="inline mr-1.5" />
                  {t('common.save')}
                </button>
                <button type="button" className="btn-secondary px-3 py-1.5 rounded-lg text-sm disabled:opacity-50" disabled={openAiChecking} onClick={checkOpenAi}>
                  {openAiChecking ? <Loader2 size={14} className="animate-spin inline mr-1.5" /> : <Wifi size={14} className="inline mr-1.5" />}
                  {t('settings.testConnection')}
                </button>
                {openAiConnection && (
                  <span role="status" aria-live="polite" className={`text-xs inline-flex items-center gap-1 min-w-0 ${openAiConnection.connected ? 'text-green-600' : 'text-red-500'}`} title={openAiConnection.message}>
                    {openAiConnection.connected ? <CheckCircle size={12} /> : <XCircle size={12} />}
                    <span className="truncate">{openAiConnection.message}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ── Appearance ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              {t('settings.appearance')}
            </h3>
            <div className="space-y-4">
              <div>
                <label htmlFor="setting-language" className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.language')}
                </label>
                <select
                  id="setting-language"
                  name="interface_language"
                  className="input w-48"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as Language)}
                >
                  <option value="en">{t('settings.languageEnglish')}</option>
                  <option value="zh-CN">{t('settings.languageChinese')}</option>
                </select>
              </div>
              <div>
                <label htmlFor="setting-theme" className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.theme')}
                </label>
                <select
                  id="setting-theme"
                  name="interface_theme"
                  className="input w-40"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}
                >
                  <option value="system">{t('settings.themeSystem')}</option>
                  <option value="light">{t('settings.themeLight')}</option>
                  <option value="dark">{t('settings.themeDark')}</option>
                </select>
              </div>
            </div>
          </div>

          {/* ── Maintenance ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              {t('settings.database')}
            </h3>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={runVacuum}
                disabled={vacuuming}
                className="btn-secondary px-3 py-1.5 rounded-lg text-sm disabled:opacity-50"
              >
                {vacuuming && <Loader2 size={14} className="animate-spin inline mr-1.5" />}
                {t('settings.vacuum')}
              </button>
              {vacuumResult && (
                <span className="text-xs text-surface-500" role="status" aria-live="polite">{vacuumResult}</span>
              )}
            </div>
          </div>

          {/* ── About ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-2">
              {t('settings.about')}
            </h3>
            <p className="text-sm text-surface-500">
              {t('settings.aboutText')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function failedPaddleStatus(error: unknown): PaddleOcrStatus {
  return {
    available: false,
    python_path: '',
    managed: true,
    install_supported: true,
    install_required: true,
    runtime_version: null,
    paddle_version: null,
    paddleocr_version: null,
    error: String(error),
  };
}
