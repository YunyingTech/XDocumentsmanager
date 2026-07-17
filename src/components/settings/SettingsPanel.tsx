import { Settings } from 'lucide-react';

export function SettingsPanel() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-4 h-12 border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950">
        <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
          Settings
        </h2>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-2xl space-y-6">
          {/* Index Settings */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              Index Settings
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  Index Storage Location
                </label>
                <input type="text" className="input" placeholder="Default: app data directory" />
              </div>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  Max File Size (MB) — skip larger PDFs
                </label>
                <input type="number" className="input w-32" defaultValue={500} min={1} />
              </div>
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  Indexer Threads
                </label>
                <input type="number" className="input w-32" defaultValue={4} min={1} max={32} />
              </div>
            </div>
          </div>

          {/* SMB / Network */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              Network (SMB) Settings
            </h3>
            <div>
              <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                Poll Interval (seconds)
              </label>
              <input type="number" className="input w-32" defaultValue={300} min={30} />
              <p className="text-xs text-surface-400 mt-1">
                How often to check SMB shares for changes.
              </p>
            </div>
          </div>

          {/* Appearance */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100 mb-4">
              Appearance
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-surface-600 dark:text-surface-400 mb-1.5">
                  Theme
                </label>
                <select className="input w-40">
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

          {/* About */}
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
