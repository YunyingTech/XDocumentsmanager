import { beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  checkAppUpdate: vi.fn(), downloadAppUpdate: vi.fn(), getAppUpdateStatus: vi.fn(),
  getSetting: vi.fn(), installAppUpdate: vi.fn(), setSetting: vi.fn(),
}));
vi.mock('../lib/tauri', () => api);
let useUpdateStore: typeof import('./updateStore').useUpdateStore;

beforeEach(async () => {
  vi.resetModules();
  ({ useUpdateStore } = await import('./updateStore'));
  api.checkAppUpdate.mockReset().mockResolvedValue(undefined);
  api.downloadAppUpdate.mockReset().mockResolvedValue(undefined);
  api.installAppUpdate.mockReset().mockResolvedValue(undefined);
  api.setSetting.mockReset().mockResolvedValue(undefined);
  api.getSetting.mockReset().mockResolvedValue(null);
  api.getAppUpdateStatus.mockReset().mockResolvedValue({ phase: 'available', version: '0.1.11', downloaded: 0, total: null, error: null });
  useUpdateStore.setState({ phase: 'idle', version: null, downloaded: 0, total: null, error: null, checkOnStartup: true, autoDownload: true, initialized: false, busy: false });
});

it('checks once on startup and only installs after the user invokes install', async () => {
  await useUpdateStore.getState().initialize();
  expect(api.checkAppUpdate).toHaveBeenCalledOnce();
  expect(api.checkAppUpdate).toHaveBeenCalledWith(true);
  expect(api.installAppUpdate).not.toHaveBeenCalled();
  expect(useUpdateStore.getState().phase).toBe('available');

  await useUpdateStore.getState().check();
  await useUpdateStore.getState().download();
  expect(api.checkAppUpdate).toHaveBeenCalledWith(false);
  expect(api.downloadAppUpdate).toHaveBeenCalledOnce();
  expect(api.installAppUpdate).not.toHaveBeenCalled();
  await useUpdateStore.getState().install();
  expect(api.installAppUpdate).toHaveBeenCalledOnce();
});

it('honors disabled startup checks and persists preference changes', async () => {
  api.getSetting.mockImplementation(async (key: string) => key === 'updates_check_on_startup' ? 'false' : null);
  await useUpdateStore.getState().initialize();
  expect(useUpdateStore.getState().checkOnStartup).toBe(false);
  expect(api.checkAppUpdate).not.toHaveBeenCalled();
  await useUpdateStore.getState().setPreference('updates_auto_download', false);
  expect(api.setSetting).toHaveBeenCalledWith('updates_auto_download', 'false');
  expect(useUpdateStore.getState().autoDownload).toBe(false);
});
