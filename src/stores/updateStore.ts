import { create } from 'zustand';
import { checkAppUpdate, downloadAppUpdate, getAppUpdateStatus, getSetting, installAppUpdate, setSetting } from '../lib/tauri';
import type { AppUpdateStatus } from '../types';

interface UpdateStore extends AppUpdateStatus {
  checkOnStartup: boolean;
  autoDownload: boolean;
  initialized: boolean;
  busy: boolean;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  setPreference: (key: 'updates_check_on_startup' | 'updates_auto_download', value: boolean) => Promise<void>;
}

const empty: AppUpdateStatus = { phase: 'idle', version: null, downloaded: 0, total: null, error: null };
let startupCheckStarted = false;

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  ...empty, checkOnStartup: true, autoDownload: true, initialized: false, busy: false,
  refresh: async () => {
    try { set(await getAppUpdateStatus()); } catch { /* Browser-only development has no Tauri backend. */ }
  },
  initialize: async () => {
    if (get().initialized) return;
    set({ initialized: true });
    try {
      const [check, download] = await Promise.all([getSetting('updates_check_on_startup'), getSetting('updates_auto_download')]);
      const checkOnStartup = check !== 'false';
      set({ checkOnStartup, autoDownload: download !== 'false' });
      if (checkOnStartup && !startupCheckStarted) {
        startupCheckStarted = true;
        await checkAppUpdate(true);
      }
    } catch (error) {
      set({ phase: 'error', error: String(error) });
    }
    await get().refresh();
  },
  check: async () => {
    if (get().busy) return;
    set({ busy: true });
    try { await checkAppUpdate(false); await get().refresh(); }
    catch (error) { await get().refresh(); set({ error: String(error) }); }
    finally { set({ busy: false }); }
  },
  download: async () => {
    if (get().busy) return;
    set({ busy: true });
    try { await downloadAppUpdate(); await get().refresh(); }
    catch (error) { await get().refresh(); set({ error: String(error) }); }
    finally { set({ busy: false }); }
  },
  install: async () => {
    if (get().busy) return;
    set({ busy: true });
    try { await installAppUpdate(); await get().refresh(); }
    catch (error) { await get().refresh(); set({ error: String(error) }); }
    finally { set({ busy: false }); }
  },
  setPreference: async (key, value) => {
    const previous = key === 'updates_check_on_startup' ? get().checkOnStartup : get().autoDownload;
    set(key === 'updates_check_on_startup' ? { checkOnStartup: value } : { autoDownload: value });
    try { await setSetting(key, String(value)); }
    catch (error) {
      set(key === 'updates_check_on_startup'
        ? { checkOnStartup: previous, error: String(error) }
        : { autoDownload: previous, error: String(error) });
    }
  },
}));
