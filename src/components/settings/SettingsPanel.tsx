import { useState, useEffect, useCallback } from 'react';
import { Settings, Wifi, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { getSetting, setSetting, checkOcrHealth, vacuumDatabase } from '../../lib/tauri';
import { useUIStore } from '../../stores/uiStore';
import type { MinerUHealthInfo } from '../../types';

export function SettingsPanel() {
  // ── State ──
  const [indexLocation, setIndexLocation] = useState('');
  const [maxFileSizeMb, setMaxFileSizeMb] = useState('500');
  const [indexerThreads, setIndexerThreads] = useState('4');
  const [pollIntervalSecs, setPollIntervalSecs] = useState('300');
  const [ocrApiUrl, setOcrApiUrl] = useState('http://127.0.0.1:8000');
  const [ocrOutputDir, setOcrOutputDir] = useState('');
  const [ocrHealth, setOcrHealth] = useState<MinerUHealthInfo | null>(null);
  const [ocrChecking, setOcrChecking] = useState(false);
  const [vacuumResult, setVacuumResult] = useState('');
  const [vacuuming, setVacuuming] = useState(false);
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);

  // ── Load settings on mount ──
  useEffect(() => {
    (async () => {
      const keys = [
        'index_location', 'max_file_size_mb', 'indexer_threads',
        'poll_interval_secs', 'ocr_api_url', 'ocr_output_dir'
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
          }
        }
      }
    })();
  }, []);

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

  // ── Vacuum ──
  const runVacuum = async () => {
    setVacuuming(true);
    setVacuumResult('');
    try {
      const result = await vacuumDatabase();
      setVacuumResult(result);
    } catch (e: any) {
      setVacuumResult(`Error: ${e}`);
    }
    setVacuuming(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center px-4 h-12 border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950">
        <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
          Settings
        </h2>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-2xl space-y-6">
          {/* ── Index Settings ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              Index Settings
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  Index Storage Location
                </label>
                <input
                  type="text"
                  className="input"
                  value={indexLocation}
                  onChange={(e) => { setIndexLocation(e.target.value); save('index_location', e.target.value); }}
                  placeholder="Default: app data directory"
                />
              </div>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  Max File Size (MB) — skip larger PDFs
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
                  Indexer Threads
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
              OCR — MinerU API
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  MinerU API URL
                </label>
                <input
                  type="text"
                  className="input"
                  value={ocrApiUrl}
                  onChange={(e) => { setOcrApiUrl(e.target.value); save('ocr_api_url', e.target.value); }}
                  placeholder="http://127.0.0.1:8000"
                />
              </div>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  OCR Output Directory
                </label>
                <input
                  type="text"
                  className="input"
                  value={ocrOutputDir}
                  onChange={(e) => { setOcrOutputDir(e.target.value); save('ocr_output_dir', e.target.value); }}
                  placeholder="Default: {project}/OCR_result"
                />
                <p className="text-xs text-surface-400 mt-1">
                  Leave empty to use the default location under the project directory.
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
                  Test Connection
                </button>
                {ocrHealth && (
                  <span className={`text-xs inline-flex items-center gap-1 ${ocrHealth.connected ? 'text-green-600' : 'text-red-500'}`}>
                    {ocrHealth.connected ? (
                      <>
                        <CheckCircle size={12} />
                        Connected — v{ocrHealth.protocol_version || '?'}, max {ocrHealth.max_concurrent_requests} concurrent
                      </>
                    ) : (
                      <>
                        <XCircle size={12} />
                        Cannot connect
                      </>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ── Network (SMB) Settings ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              Network (SMB) Settings
            </h3>
            <div>
              <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                Poll Interval (seconds)
              </label>
              <input
                type="number"
                className="input w-32"
                value={pollIntervalSecs}
                min={30}
                onChange={(e) => { setPollIntervalSecs(e.target.value); save('poll_interval_secs', e.target.value); }}
              />
              <p className="text-xs text-surface-400 mt-1">
                How often to check SMB shares for changes.
              </p>
            </div>
          </div>

          {/* ── Appearance ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              Appearance
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  Theme
                </label>
                <select
                  className="input w-40"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  Default View
                </label>
                <select className="input w-40">
                  <option value="table">Table</option>
                  <option value="grid">Grid</option>
                </select>
              </div>
            </div>
          </div>

          {/* ── Maintenance ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              Database
            </h3>
            <div className="flex items-center gap-3">
              <button
                onClick={runVacuum}
                disabled={vacuuming}
                className="btn-secondary px-3 py-1.5 rounded-lg text-sm disabled:opacity-50"
              >
                {vacuuming && <Loader2 size={14} className="animate-spin inline mr-1.5" />}
                Vacuum Database
              </button>
              {vacuumResult && (
                <span className="text-xs text-surface-500">{vacuumResult}</span>
              )}
            </div>
          </div>

          {/* ── About ── */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-2">
              About
            </h3>
            <p className="text-sm text-surface-500">
              XDocuments Manager v0.1.0 — A 60TB-scale PDF document manager for Windows.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
