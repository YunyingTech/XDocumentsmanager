import { Activity, PanelLeftOpen, PanelsTopLeft, ScrollText } from 'lucide-react';
import { useI18n, type TranslationKey } from '../../lib/i18n';
import { useSearchStore } from '../../stores/searchStore';
import { useUIStore, type SurfaceView } from '../../stores/uiStore';

const stageKeys: Record<string, TranslationKey> = {
  preparing: 'search.stagePreparing',
  analyzing: 'search.stageAnalyzing',
  searching: 'search.stageSearching',
  resolving: 'search.stageResolving',
  completed: 'search.stageCompleted',
  failed: 'search.stageFailed',
};

export function ViewToolbar() {
  const { t } = useI18n();
  const surfaceView = useUIStore((state) => state.surfaceView);
  const setSurfaceView = useUIStore((state) => state.setSurfaceView);
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSearching = useSearchStore((state) => state.isSearching);
  const progress = useSearchStore((state) => state.progress);

  const options: Array<{ id: SurfaceView; label: TranslationKey; icon: typeof PanelsTopLeft }> = [
    { id: 'workspace', label: 'toolbar.workspace', icon: PanelsTopLeft },
    { id: 'logs', label: 'toolbar.logs', icon: ScrollText },
  ];

  return (
    <header className="flex h-10 shrink-0 items-center border-b border-surface-200 bg-surface-50 px-2 dark:border-surface-800 dark:bg-surface-950">
      {!sidebarOpen && (
        <button type="button" className="icon-button mr-1" onClick={toggleSidebar} title={t('toolbar.showSidebar')} aria-label={t('toolbar.showSidebar')}>
          <PanelLeftOpen size={15} />
        </button>
      )}
      <nav className="flex h-8 items-center gap-0.5 rounded-md border border-surface-200 bg-white p-0.5 dark:border-surface-700 dark:bg-surface-900" aria-label={t('toolbar.view')}>
        {options.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSurfaceView(id)}
            className={`flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors ${surfaceView === id ? 'bg-surface-200 text-surface-900 dark:bg-surface-700 dark:text-surface-100' : 'text-surface-500 hover:bg-surface-100 hover:text-surface-800 dark:hover:bg-surface-800 dark:hover:text-surface-200'}`}
            aria-current={surfaceView === id ? 'page' : undefined}
          >
            <Icon size={14} />
            <span>{t(label)}</span>
          </button>
        ))}
      </nav>
      {isSearching && progress && (
        <div className="ml-auto flex min-w-0 items-center gap-2 text-xs text-surface-500" role="status">
          <Activity size={14} className="shrink-0 text-accent-500" />
          <span className="max-w-48 truncate">{t(stageKeys[progress.stage] ?? 'search.searching')}</span>
          <span className="w-8 text-right font-mono tabular-nums text-surface-400">{progress.progress}%</span>
          <div className="h-1 w-20 overflow-hidden rounded-sm bg-surface-200 dark:bg-surface-700">
            <div className="h-full bg-accent-500 transition-[width] duration-300" style={{ width: `${progress.progress}%` }} />
          </div>
        </div>
      )}
    </header>
  );
}
