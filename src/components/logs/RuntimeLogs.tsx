import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, Clipboard, Pause, Radio, RefreshCw, Search,
  Server, TerminalSquare,
} from 'lucide-react';
import { getRuntimeLogs } from '../../lib/tauri';
import { useI18n } from '../../lib/i18n';
import type { RuntimeLogSnapshot, RuntimeLogSource } from '../../types';

type LogLevel = 'all' | 'error' | 'warn' | 'info' | 'debug';

function lineLevel(line: string): Exclude<LogLevel, 'all'> {
  const match = line.match(/\[(ERROR|WARN|INFO|DEBUG|TRACE)\s*\]/i);
  const level = match?.[1]?.toLowerCase();
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';
  if (level === 'debug' || level === 'trace') return 'debug';
  return 'info';
}

const levelStyles: Record<Exclude<LogLevel, 'all'>, string> = {
  error: 'border-red-500/70 bg-red-500/5 text-red-700 dark:text-red-300',
  warn: 'border-amber-500/70 bg-amber-500/5 text-amber-700 dark:text-amber-300',
  info: 'border-transparent text-surface-600 dark:text-surface-300',
  debug: 'border-transparent text-surface-400 dark:text-surface-500',
};

export function RuntimeLogs() {
  const { locale, t } = useI18n();
  const [source, setSource] = useState<RuntimeLogSource>('application');
  const [snapshot, setSnapshot] = useState<RuntimeLogSnapshot | null>(null);
  const [level, setLevel] = useState<LogLevel>('all');
  const [filter, setFilter] = useState('');
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async (showLoading = false) => {
    const requestId = ++requestRef.current;
    if (showLoading) setLoading(true);
    try {
      const next = await getRuntimeLogs(source, 800);
      if (requestId === requestRef.current) {
        setSnapshot(next);
        setError(null);
      }
    } catch (reason) {
      if (requestId === requestRef.current) setError(String(reason));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    setSnapshot(null);
    void refresh(true);
    if (!live) return;
    const timer = window.setInterval(() => void refresh(false), 2000);
    return () => window.clearInterval(timer);
  }, [live, refresh]);

  const visibleLines = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return (snapshot?.lines ?? []).filter((line) => {
      const matchesLevel = level === 'all' || lineLevel(line) === level;
      const matchesText = !needle || line.toLocaleLowerCase().includes(needle);
      return matchesLevel && matchesText;
    });
  }, [filter, level, snapshot]);

  useEffect(() => {
    if (live) viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight });
  }, [live, visibleLines]);

  const copyVisible = async () => {
    await navigator.clipboard.writeText(visibleLines.join('\n'));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-white dark:bg-surface-950" aria-label={t('logs.title')}>
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-surface-200 px-3 py-2 dark:border-surface-800">
        <div className="flex h-8 items-center rounded-md bg-surface-100 p-0.5 dark:bg-surface-900" role="tablist" aria-label={t('logs.source')}>
          <SourceButton active={source === 'application'} onClick={() => setSource('application')} icon={TerminalSquare} label={t('logs.application')} />
          <SourceButton active={source === 'elasticsearch'} onClick={() => setSource('elasticsearch')} icon={Server} label={t('logs.elasticsearch')} />
        </div>
        <div className="relative min-w-40 flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-surface-400" aria-hidden="true" />
          <input name="log_filter" autoComplete="off" aria-label={t('logs.filter')} value={filter} onChange={(event) => setFilter(event.target.value)} className="h-8 w-full rounded-md border border-surface-200 bg-surface-50 pl-8 pr-2 text-xs text-surface-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-200" placeholder={`${t('logs.filter')}…`} />
        </div>
        <select name="log_level" value={level} onChange={(event) => setLevel(event.target.value as LogLevel)} className="h-8 rounded-md border border-surface-200 bg-surface-50 px-2 text-xs text-surface-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 dark:border-surface-700 dark:bg-surface-900 dark:text-surface-300" aria-label={t('logs.level')}>
          <option value="all">{t('logs.levelAll')}</option>
          <option value="error">{t('logs.levelError')}</option>
          <option value="warn">{t('logs.levelWarn')}</option>
          <option value="info">{t('logs.levelInfo')}</option>
          <option value="debug">{t('logs.levelDebug')}</option>
        </select>
        <button type="button" onClick={() => setLive((value) => !value)} className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${live ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'border-surface-200 text-surface-500 dark:border-surface-700'}`} aria-pressed={live}>
          {live ? <Radio size={13} /> : <Pause size={13} />}
          {live ? t('logs.live') : t('logs.paused')}
        </button>
        <button type="button" className="icon-button" onClick={() => void refresh(true)} title={t('common.refresh')} aria-label={t('common.refresh')}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <button type="button" className="icon-button" onClick={() => void copyVisible()} disabled={visibleLines.length === 0} title={copied ? t('logs.copied') : t('logs.copy')} aria-label={copied ? t('logs.copied') : t('logs.copy')}>
          {copied ? <Check size={14} className="text-emerald-600" /> : <Clipboard size={14} />}
        </button>
      </header>

      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-surface-200 bg-surface-50 px-3 font-mono text-[11px] text-surface-400 dark:border-surface-800 dark:bg-surface-900/60">
        <span className="min-w-0 flex-1 truncate" title={snapshot?.path}>{snapshot?.path || t('logs.pathPending')}</span>
        <span className="shrink-0 tabular-nums">{t('logs.linesShown', { count: visibleLines.length })}</span>
        {snapshot?.updated_at && <span className="hidden shrink-0 tabular-nums md:inline">{new Date(snapshot.updated_at).toLocaleTimeString(locale)}</span>}
      </div>

      <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto bg-[#fbfbfb] dark:bg-[#101010]">
        {error ? (
          <div className="flex h-full items-center justify-center gap-2 p-6 text-sm text-red-600" role="alert"><AlertTriangle size={16} aria-hidden="true" />{t('logs.loadFailed', { error })}</div>
        ) : loading && !snapshot ? (
          <div className="space-y-px p-3">{Array.from({ length: 12 }, (_, index) => <div key={index} className="h-5 animate-pulse bg-surface-100 dark:bg-surface-900" style={{ width: `${62 + (index % 4) * 9}%` }} />)}</div>
        ) : visibleLines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <TerminalSquare size={24} className="mb-3 text-surface-300 dark:text-surface-700" />
            <p className="text-sm font-medium text-surface-600 dark:text-surface-300">{t('logs.empty')}</p>
            <p className="mt-1 text-xs text-surface-400">{t('logs.emptyHint')}</p>
          </div>
        ) : (
          <div className="min-w-full py-1 font-mono text-[11px] leading-5">
            {visibleLines.map((line, index) => {
              const detectedLevel = lineLevel(line);
              return (
                <div
                  key={`${index}-${line}`}
                  style={{ contentVisibility: 'auto', containIntrinsicSize: '0 20px' }}
                  className={`grid min-w-max grid-cols-[3.5rem_minmax(0,1fr)] border-l-2 pr-4 hover:bg-surface-100 dark:hover:bg-surface-900 ${levelStyles[detectedLevel]}`}
                >
                  <span className="select-none border-r border-surface-200 px-2 text-right tabular-nums text-surface-300 dark:border-surface-800 dark:text-surface-700">{index + 1}</span>
                  <span className="whitespace-pre-wrap break-all px-3">{line}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function SourceButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof TerminalSquare; label: string }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors ${active ? 'bg-white text-surface-900 shadow-sm dark:bg-surface-700 dark:text-surface-100' : 'text-surface-500 hover:text-surface-800 dark:hover:text-surface-200'}`}>
      <Icon size={13} />
      {label}
    </button>
  );
}
