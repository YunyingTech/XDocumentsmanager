import { DEFAULT_RAPID_OCR_WORKERS, MAX_RAPID_OCR_WORKERS, rapidWorkerCountValue } from '../../lib/rapidOcrConfig';
import { useState, useEffect, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Wifi, Loader2, CheckCircle, XCircle, Save, Trash2, Monitor, Server, Boxes, Download, Zap } from 'lucide-react';
import { getSetting, setSetting, checkOcrHealth, getWindowsOcrStatus, getPaddleOcrStatus, installPaddleOcr, getRapidOcrStatus, installRapidOcr, vacuumDatabase, getOpenAiConfig, setOpenAiConfig, testOpenAiConnection, getSearchBackendStatus } from '../../lib/tauri';
import { useUIStore } from '../../stores/uiStore';
import type { MinerUHealthInfo, OcrEngine, PaddleDeviceMode, PaddleInstallProgress, PaddleOcrStatus, PaddlePackageIndex, RapidDeviceMode, RapidInstallProgress, RapidOcrStatus, SearchBackendStatus, WindowsOcrStatus } from '../../types';
import { useI18n } from '../../lib/i18n';
import { APP_VERSION } from '../../lib/constants';
import type { Language } from '../../stores/uiStore';

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

export function SettingsPanel() {
  const { t } = useI18n();
  // ── State ──
  const [maxFileSizeMb, setMaxFileSizeMb] = useState('500');
  const [ocrApiUrl, setOcrApiUrl] = useState('http://127.0.0.1:8000');
  const [ocrOutputDir, setOcrOutputDir] = useState('');
  const [ocrEngine, setOcrEngine] = useState<OcrEngine>('rapid');
  const [windowsOcrLanguage, setWindowsOcrLanguage] = useState('auto');
  const [windowsOcrStatus, setWindowsOcrStatus] = useState<WindowsOcrStatus | null>(null);
  const [paddleLanguage, setPaddleLanguage] = useState('ch');
  const [paddleModel, setPaddleModel] = useState('PP-OCRv5_mobile');
  const [paddleDeviceMode, setPaddleDeviceMode] = useState<PaddleDeviceMode>('auto');
  const [paddlePypiPrimary, setPaddlePypiPrimary] = useState<PaddlePackageIndex>('ustc');
  const [paddlePypiFallback, setPaddlePypiFallback] = useState<PaddlePackageIndex>('tsinghua');
  const [paddleStatus, setPaddleStatus] = useState<PaddleOcrStatus | null>(null);
  const [paddleInstallProgress, setPaddleInstallProgress] = useState<PaddleInstallProgress | null>(null);
  const [paddleInstalling, setPaddleInstalling] = useState(false);
  const [rapidLanguage, setRapidLanguage] = useState('ch');
  const [rapidDeviceMode, setRapidDeviceMode] = useState<RapidDeviceMode>('auto');
  const [rapidWorkerCount, setRapidWorkerCount] = useState(DEFAULT_RAPID_OCR_WORKERS);
  const [rapidStatus, setRapidStatus] = useState<RapidOcrStatus | null>(null);
  const [rapidInstallProgress, setRapidInstallProgress] = useState<RapidInstallProgress | null>(null);
  const [rapidInstalling, setRapidInstalling] = useState(false);
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
        'paddle_ocr_language', 'paddle_ocr_model', 'paddle_device_mode', 'paddle_pypi_primary', 'paddle_pypi_fallback',
        'rapidocr_language', 'rapidocr_device_mode', 'rapidocr_worker_count'
      ];
      for (const key of keys) {
        const val = await getSetting(key);
        if (val != null) {
          switch (key) {
            case 'max_file_size_mb': setMaxFileSizeMb(val); break;
            case 'ocr_api_url': setOcrApiUrl(val); break;
            case 'ocr_output_dir': setOcrOutputDir(val); break;
            case 'ocr_engine': setOcrEngine(val === 'rapid' || val === 'mineru' || val === 'windows' || val === 'paddle' ? val : 'rapid'); break;
            case 'windows_ocr_language': setWindowsOcrLanguage(val); break;
            case 'paddle_ocr_language': setPaddleLanguage(val); break;
            case 'paddle_ocr_model': setPaddleModel(val); break;
            case 'paddle_device_mode': setPaddleDeviceMode(deviceMode(val)); break;
            case 'paddle_pypi_primary': setPaddlePypiPrimary(packageIndex(val, 'ustc')); break;
            case 'paddle_pypi_fallback': setPaddlePypiFallback(packageIndex(val, 'tsinghua')); break;
            case 'rapidocr_language': setRapidLanguage(val); break;
            case 'rapidocr_device_mode': setRapidDeviceMode(rapidDeviceModeValue(val)); break;
            case 'rapidocr_worker_count': setRapidWorkerCount(rapidWorkerCountValue(val)); break;
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
    const unlisten = listen<RapidInstallProgress>('rapid-install:progress', (event) => {
      setRapidInstallProgress(event.payload);
      setRapidInstalling(event.payload.stage !== 'completed' && event.payload.stage !== 'failed');
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

  useEffect(() => {
    if (ocrEngine !== 'rapid') return;
    let active = true;
    getRapidOcrStatus()
      .then((status) => { if (active) setRapidStatus(status); })
      .catch((error) => { if (active) setRapidStatus(failedRapidStatus(error)); });
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
    if (ocrEngine === 'rapid') {
      try {
        setRapidStatus(await getRapidOcrStatus());
      } catch (error) {
        setRapidStatus(failedRapidStatus(error));
      }
      setOcrChecking(false);
      return;
    }
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
      const status = await installPaddleOcr(paddlePypiPrimary, paddlePypiFallback, paddleDeviceMode);
      setPaddleStatus(status);
    } catch (error) {
      setPaddleStatus(failedPaddleStatus(error));
      setPaddleInstallProgress({ stage: 'failed', progress: 100, message: String(error) });
    } finally {
      setPaddleInstalling(false);
    }
  };

  const installRapid = async () => {
    if (rapidInstalling) return;
    setRapidInstalling(true);
    setRapidInstallProgress({ stage: 'preparing', progress: 0, message: '' });
    try {
      setRapidStatus(await installRapidOcr(rapidDeviceMode));
    } catch (error) {
      setRapidStatus(failedRapidStatus(error));
      setRapidInstallProgress({ stage: 'failed', progress: 100, message: String(error) });
    } finally {
      setRapidInstalling(false);
    }
  };

  const selectRapidDeviceMode = async (value: RapidDeviceMode) => {
    setRapidDeviceMode(value);
    setRapidStatus(null);
    await save('rapidocr_device_mode', value);
    setOcrChecking(true);
    try {
      setRapidStatus(await getRapidOcrStatus());
    } catch (error) {
      setRapidStatus(failedRapidStatus(error));
    } finally {
      setOcrChecking(false);
    }
  };

  const selectPaddleDeviceMode = async (value: PaddleDeviceMode) => {
    setPaddleDeviceMode(value);
    setPaddleStatus(null);
    await save('paddle_device_mode', value);
    setOcrChecking(true);
    try {
      setPaddleStatus(await getPaddleOcrStatus());
    } catch (error) {
      setPaddleStatus(failedPaddleStatus(error));
    } finally {
      setOcrChecking(false);
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
                  <button type="button" aria-pressed={ocrEngine === 'rapid'} onClick={() => { setOcrEngine('rapid'); save('ocr_engine', 'rapid'); setRapidStatus(null); }} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${ocrEngine === 'rapid' ? 'bg-white shadow-sm dark:bg-surface-700' : 'text-surface-500'}`}>
                    <Zap size={14} /> RapidOCR
                  </button>
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
              {ocrEngine === 'rapid' ? <div className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="setting-rapid-language" className="mb-1.5 block text-sm text-surface-600 dark:text-surface-400">{t('ocr.rapidLanguage')}</label>
                    <select id="setting-rapid-language" name="rapidocr_language" className="input" value={rapidLanguage} onChange={(event) => { setRapidLanguage(event.target.value); void save('rapidocr_language', event.target.value); }}>
                      <option value="ch">中文</option>
                      <option value="en">English</option>
                      <option value="japan">日本語</option>
                      <option value="korean">한국어</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="setting-rapid-workers" className="mb-1.5 block text-sm text-surface-600 dark:text-surface-400">{t('ocr.rapidWorkers')}</label>
                    <input
                      id="setting-rapid-workers"
                      name="rapidocr_worker_count"
                      type="number"
                      min={1}
                      max={MAX_RAPID_OCR_WORKERS}
                      step={1}
                      className="input"
                      value={rapidWorkerCount}
                      onChange={(event) => {
                        const count = rapidWorkerCountValue(event.currentTarget.value);
                        setRapidWorkerCount(count);
                        void save('rapidocr_worker_count', String(count));
                      }}
                    />
                  </div>
                </div>
                <div>
                  <span className="mb-1.5 block text-sm text-surface-600 dark:text-surface-400">{t('ocr.rapidDevice')}</span>
                  <RapidDeviceModeControl value={rapidDeviceMode} onChange={(value) => void selectRapidDeviceMode(value)} disabled={ocrChecking || rapidInstalling} t={t} />
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <button type="button" className="btn-secondary inline-flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-xs disabled:opacity-50" onClick={() => void installRapid()} disabled={ocrChecking || rapidInstalling || rapidStatus?.install_supported === false}>
                    {rapidInstalling ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                    {t('ocr.installRapid')}
                  </button>
                  {!rapidInstalling && rapidStatus && (
                    <p className={`min-w-0 truncate text-xs ${rapidStatus.available ? 'text-green-600' : 'text-red-500'}`} title={rapidStatus.error ?? undefined}>
                      {rapidStatus.available ? rapidRuntimeLabel(rapidStatus, t) : rapidStatus.error}
                    </p>
                  )}
                </div>
                {!rapidInstalling && rapidStatus?.fallback_reason && <p className="text-xs text-amber-600 dark:text-amber-400">{rapidStatus.fallback_reason}</p>}
                {rapidInstalling && rapidInstallProgress && (
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
              </div> : ocrEngine === 'mineru' ? <div>
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
                <div>
                  <span className="mb-1.5 block text-sm text-surface-600 dark:text-surface-400">{t('ocr.paddleDevice')}</span>
                  <PaddleDeviceModeControl
                    value={paddleDeviceMode}
                    onChange={(value) => void selectPaddleDeviceMode(value)}
                    disabled={ocrChecking || paddleInstalling}
                    t={t}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="setting-paddle-pypi-primary" className="mb-1.5 block text-sm text-surface-600 dark:text-surface-400">{t('ocr.paddlePypiPrimary')}</label>
                    <select id="setting-paddle-pypi-primary" name="paddle_pypi_primary" className="input" value={paddlePypiPrimary} onChange={(event) => { const value = event.target.value as PaddlePackageIndex; setPaddlePypiPrimary(value); void save('paddle_pypi_primary', value); }}>
                      <PaddlePackageIndexOptions t={t} />
                    </select>
                  </div>
                  <div>
                    <label htmlFor="setting-paddle-pypi-fallback" className="mb-1.5 block text-sm text-surface-600 dark:text-surface-400">{t('ocr.paddlePypiFallback')}</label>
                    <select id="setting-paddle-pypi-fallback" name="paddle_pypi_fallback" className="input" value={paddlePypiFallback} onChange={(event) => { const value = event.target.value as PaddlePackageIndex; setPaddlePypiFallback(value); void save('paddle_pypi_fallback', value); }}>
                      <PaddlePackageIndexOptions t={t} />
                    </select>
                  </div>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  <button type="button" className="btn-secondary inline-flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-xs disabled:opacity-50" onClick={() => void installPaddle()} disabled={ocrChecking || paddleInstalling || paddleStatus?.install_supported === false || (paddleDeviceMode === 'cuda12' && paddleStatus?.gpu_compatible === false)}>
                    {paddleInstalling ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                    {t('ocr.installPaddle')}
                  </button>
                  {!paddleInstalling && paddleStatus && (
                    <p className={`min-w-0 truncate text-xs ${paddleStatus.available ? 'text-green-600' : 'text-red-500'}`} title={paddleStatus.error ?? undefined}>
                      {paddleStatus.available ? paddleRuntimeLabel(paddleStatus, t) : paddleStatus.error}
                    </p>
                  )}
                </div>
                {!paddleInstalling && paddleStatus?.fallback_reason && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">{paddleStatus.fallback_reason}</p>
                )}
                {!paddleInstalling && paddleStatus?.gpu_detected && (
                  <p className="text-[11px] text-surface-400">
                    {[paddleStatus.gpu_name, paddleStatus.gpu_compute_capability ? `CC ${paddleStatus.gpu_compute_capability}` : null, paddleStatus.gpu_driver_version ? `${t('ocr.paddleDriver')} ${paddleStatus.gpu_driver_version}` : null].filter(Boolean).join(' · ')}
                  </p>
                )}
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
                {ocrEngine === 'rapid' && rapidStatus && (
                  <span role="status" aria-live="polite" className={`inline-flex min-w-0 items-center gap-1 text-xs ${rapidStatus.available ? 'text-green-600' : 'text-red-500'}`} title={rapidStatus.error ?? undefined}>
                    {rapidStatus.available ? <CheckCircle size={12} /> : <XCircle size={12} />}
                    <span className="truncate">{rapidStatus.available ? t('ocr.rapidReady') : t('ocr.rapidUnavailable')}</span>
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
              {t('settings.aboutText', { version: APP_VERSION })}
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
    requested_device_mode: 'auto',
    active_device: null,
    runtime_profile: null,
    gpu_detected: false,
    gpu_compatible: false,
    gpu_runtime_installed: false,
    gpu_name: null,
    gpu_compute_capability: null,
    gpu_driver_version: null,
    cuda_version: null,
    cudnn_version: null,
    fallback_reason: null,
    error: String(error),
  };
}

function failedRapidStatus(error: unknown): RapidOcrStatus {
  return {
    available: false,
    python_path: '',
    managed: true,
    install_supported: true,
    install_required: true,
    runtime_version: null,
    rapidocr_version: null,
    onnxruntime_version: null,
    pymupdf_version: null,
    requested_device_mode: 'auto',
    requested_provider: null,
    active_provider: null,
    accelerated: false,
    available_providers: [],
    session_providers: [],
    runtime_profile: null,
    fallback_reason: null,
    error: String(error),
  };
}

function packageIndex(value: string, fallback: PaddlePackageIndex): PaddlePackageIndex {
  return value === 'ustc' || value === 'tsinghua' || value === 'official' ? value : fallback;
}

function deviceMode(value: string): PaddleDeviceMode {
  return value === 'cpu' || value === 'cuda12' ? value : 'auto';
}

function rapidDeviceModeValue(value: string): RapidDeviceMode {
  return value === 'cpu' ? 'cpu' : 'auto';
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
  return `RapidOCR ${status.rapidocr_version ?? ''} · ${status.accelerated ? t('ocr.rapidAccelerated') : t('ocr.rapidCpu')} · ${status.active_provider ?? '?'}`;
}

function paddleRuntimeLabel(status: PaddleOcrStatus, t: ReturnType<typeof useI18n>['t']) {
  const device = status.active_device === 'gpu:0'
    ? `${t('ocr.paddleDeviceCuda')}${status.cuda_version ? ` (${status.cuda_version})` : ''}`
    : t('ocr.paddleDeviceCpu');
  return `PaddleOCR ${status.paddleocr_version ?? ''} · ${device}`;
}
