import { useState, useEffect, useCallback } from 'react';
import { Wifi, Loader2, CheckCircle, XCircle, Save, Trash2, Monitor, Server } from 'lucide-react';
import { getSetting, setSetting, checkOcrHealth, getWindowsOcrStatus, vacuumDatabase, getOpenAiConfig, setOpenAiConfig, testOpenAiConnection, getSearchBackendStatus } from '../../lib/tauri';
import { useUIStore } from '../../stores/uiStore';
import type { MinerUHealthInfo, OcrEngine, SearchBackendStatus, WindowsOcrStatus } from '../../types';
import { useI18n } from '../../lib/i18n';
import type { Language } from '../../stores/uiStore';

export function SettingsPanel() {
  const { t } = useI18n();
  // ── State ──
  const [indexLocation, setIndexLocation] = useState('');
  const [maxFileSizeMb, setMaxFileSizeMb] = useState('500');
  const [indexerThreads, setIndexerThreads] = useState('4');
  const [pollIntervalSecs, setPollIntervalSecs] = useState('300');
  const [ocrApiUrl, setOcrApiUrl] = useState('http://127.0.0.1:8000');
  const [ocrOutputDir, setOcrOutputDir] = useState('');
  const [ocrEngine, setOcrEngine] = useState<OcrEngine>('mineru');
  const [windowsOcrLanguage, setWindowsOcrLanguage] = useState('auto');
  const [windowsOcrStatus, setWindowsOcrStatus] = useState<WindowsOcrStatus | null>(null);
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
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);

  // ── Load settings on mount ──
  useEffect(() => {
    (async () => {
      const keys = [
        'index_location', 'max_file_size_mb', 'indexer_threads',
        'poll_interval_secs', 'ocr_api_url', 'ocr_output_dir', 'ocr_engine', 'windows_ocr_language'
      ];
      for (const key of keys) {
        const val = await getSetting(key);
        if (val != null) {
          switch (key) {
            case 'index_location': setIndexLocation(val); break;
            case 'max_file_size_mb': setMaxFileSizeMb(val); break;
            case 'indexer_threads': setIndexerThreads(val); break;
            case 'poll_interval_secs': setPollIntervalSecs(val); break;
            case 'ocr_api_url': setOcrApiUrl(val); break;
            case 'ocr_output_dir': setOcrOutputDir(val); break;
            case 'ocr_engine': setOcrEngine(val === 'windows' ? 'windows' : 'mineru'); break;
            case 'windows_ocr_language': setWindowsOcrLanguage(val); break;
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

  // ── Save helpers (auto-save on change) ──
  const save = useCallback(async (key: string, value: string) => {
    try {
      await setSetting(key, value);
    } catch (e) {
      console.error(`Failed to save ${key}:`, e);
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

  const saveOpenAi = async (apiKey: string | undefined = openAiApiKey || undefined) => {
    const config = await setOpenAiConfig(openAiEndpoint, openAiModel, apiKey, smartSearchEnabled);
    setOpenAiKeyConfigured(config.api_key_configured);
    setOpenAiApiKey('');
    return config;
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
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.indexLocation')}
                </label>
                <input
                  type="text"
                  className="input"
                  value={indexLocation}
                  onChange={(e) => { setIndexLocation(e.target.value); save('index_location', e.target.value); }}
                  placeholder={t('settings.indexLocationPlaceholder')}
                />
              </div>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.maxFileSize')}
                </label>
                <input
                  type="number"
                  className="input w-32"
                  value={maxFileSizeMb}
                  min={1}
                  onChange={(e) => { setMaxFileSizeMb(e.target.value); save('max_file_size_mb', e.target.value); }}
                />
              </div>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.indexerThreads')}
                </label>
                <input
                  type="number"
                  className="input w-32"
                  value={indexerThreads}
                  min={1}
                  max={32}
                  onChange={(e) => { setIndexerThreads(e.target.value); save('indexer_threads', e.target.value); }}
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
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('ocr.engine')}
                </label>
                <div className="inline-flex rounded-md border border-surface-200 bg-surface-50 p-0.5 dark:border-surface-700 dark:bg-surface-900">
                  <button type="button" onClick={() => { setOcrEngine('mineru'); save('ocr_engine', 'mineru'); setOcrHealth(null); }} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${ocrEngine === 'mineru' ? 'bg-white shadow-sm dark:bg-surface-700' : 'text-surface-500'}`}>
                    <Server size={14} /> MinerU
                  </button>
                  <button type="button" onClick={() => { setOcrEngine('windows'); save('ocr_engine', 'windows'); setWindowsOcrStatus(null); }} className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium ${ocrEngine === 'windows' ? 'bg-white shadow-sm dark:bg-surface-700' : 'text-surface-500'}`}>
                    <Monitor size={14} /> {t('ocr.windowsEngine')}
                  </button>
                </div>
              </div>
              {ocrEngine === 'mineru' ? <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.ocrApiUrl')}
                </label>
                <input
                  type="text"
                  className="input"
                  value={ocrApiUrl}
                  onChange={(e) => { setOcrApiUrl(e.target.value); save('ocr_api_url', e.target.value); }}
                  placeholder="http://127.0.0.1:8000"
                />
              </div> : <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('ocr.windowsLanguage')}
                </label>
                <select className="input" value={windowsOcrLanguage} disabled={!windowsOcrStatus?.available} onChange={(event) => { setWindowsOcrLanguage(event.target.value); save('windows_ocr_language', event.target.value); }}>
                  <option value="auto">{t('ocr.languageAuto')}</option>
                  {windowsOcrStatus?.languages.map((item) => <option key={item.tag} value={item.tag}>{item.native_name} ({item.tag})</option>)}
                </select>
                {windowsOcrStatus?.error && <p className="mt-1 text-xs text-red-500">{windowsOcrStatus.error}</p>}
              </div>}
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.ocrOutput')}
                </label>
                <input
                  type="text"
                  className="input"
                  value={ocrOutputDir}
                  onChange={(e) => { setOcrOutputDir(e.target.value); save('ocr_output_dir', e.target.value); }}
                  placeholder={t('ocr.outputPlaceholder', { project: '{project}' })}
                />
                <p className="text-xs text-surface-400 mt-1">
                  {t('settings.ocrOutputHint')}
                </p>
              </div>

              {/* Health check */}
              <div className="flex items-center gap-3 pt-1">
                <button
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
                  <span className={`text-xs inline-flex items-center gap-1 ${ocrHealth.connected ? 'text-green-600' : 'text-red-500'}`}>
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
                  <span className={`text-xs inline-flex items-center gap-1 ${windowsOcrStatus.available ? 'text-green-600' : 'text-red-500'}`}>
                    {windowsOcrStatus.available ? <CheckCircle size={12} /> : <XCircle size={12} />}
                    {windowsOcrStatus.available ? t('ocr.windowsReady') : t('ocr.windowsUnavailable')}
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
              <div className="flex items-center justify-between gap-4 text-sm">
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
                  type="checkbox"
                  checked={smartSearchEnabled}
                  onChange={(event) => setSmartSearchEnabled(event.target.checked)}
                  className="h-4 w-4 accent-accent-500"
                />
              </label>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.openAiEndpoint')}
                </label>
                <input className="input" value={openAiEndpoint} onChange={(event) => setOpenAiEndpoint(event.target.value)} placeholder="https://api.openai.com/v1" />
              </div>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.openAiModel')}
                </label>
                <input className="input" value={openAiModel} onChange={(event) => setOpenAiModel(event.target.value)} placeholder="gpt-4.1-mini" />
              </div>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.openAiApiKey')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    className="input flex-1"
                    value={openAiApiKey}
                    onChange={(event) => setOpenAiApiKey(event.target.value)}
                    placeholder={openAiKeyConfigured ? t('settings.apiKeySaved') : 'sk-...'}
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
                  <span className={`text-xs inline-flex items-center gap-1 min-w-0 ${openAiConnection.connected ? 'text-green-600' : 'text-red-500'}`} title={openAiConnection.message}>
                    {openAiConnection.connected ? <CheckCircle size={12} /> : <XCircle size={12} />}
                    <span className="truncate">{openAiConnection.message}</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ── Network (SMB) Settings ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              {t('settings.network')}
            </h3>
            <div>
              <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                {t('settings.pollInterval')}
              </label>
              <input
                type="number"
                className="input w-32"
                value={pollIntervalSecs}
                min={30}
                onChange={(e) => { setPollIntervalSecs(e.target.value); save('poll_interval_secs', e.target.value); }}
              />
              <p className="text-xs text-surface-400 mt-1">
                {t('settings.pollIntervalHint')}
              </p>
            </div>
          </div>

          {/* ── Appearance ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              {t('settings.appearance')}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.language')}
                </label>
                <select
                  className="input w-48"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as Language)}
                >
                  <option value="en">{t('settings.languageEnglish')}</option>
                  <option value="zh-CN">{t('settings.languageChinese')}</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.theme')}
                </label>
                <select
                  className="input w-40"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}
                >
                  <option value="system">{t('settings.themeSystem')}</option>
                  <option value="light">{t('settings.themeLight')}</option>
                  <option value="dark">{t('settings.themeDark')}</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  {t('settings.defaultView')}
                </label>
                <select className="input w-40">
                  <option value="table">{t('settings.viewTable')}</option>
                  <option value="grid">{t('settings.viewGrid')}</option>
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
                onClick={runVacuum}
                disabled={vacuuming}
                className="btn-secondary px-3 py-1.5 rounded-lg text-sm disabled:opacity-50"
              >
                {vacuuming && <Loader2 size={14} className="animate-spin inline mr-1.5" />}
                {t('settings.vacuum')}
              </button>
              {vacuumResult && (
                <span className="text-xs text-surface-500">{vacuumResult}</span>
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
