import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  update: { phase: 'ready', version: '0.1.11', downloaded: 100, total: 100, error: null as string | null, busy: false, checkOnStartup: true, autoDownload: true, check: vi.fn(), download: vi.fn(), install: vi.fn(), setPreference: vi.fn() },
  index: { indexProgressByJob: {} as Record<number, { status: string }> },
  ocr: { isSubmitting: false, bulkOcrRunning: false, isInstallingPaddle: false, isInstallingRapid: false, tasks: [] as Array<{ status: string }> },
}));
vi.mock('../../stores/updateStore', () => ({ useUpdateStore: () => mocks.update }));
vi.mock('../../stores/folderStore', () => ({ useFolderStore: (selector: (value: typeof mocks.index) => unknown) => selector(mocks.index) }));
vi.mock('../../stores/ocrStore', () => ({ useOcrStore: (selector: (value: typeof mocks.ocr) => unknown) => selector(mocks.ocr) }));
vi.mock('../../lib/i18n', () => ({ useI18n: () => ({ t: (key: string, vars?: Record<string, unknown>) => vars ? `${key}:${vars.error ?? vars.version ?? ''}` : key }) }));
import { UpdateSettings } from './UpdateSettings';

beforeEach(() => {
  mocks.update.phase = 'ready';
  mocks.update.error = null;
  mocks.update.busy = false;
  mocks.update.install.mockReset();
  mocks.update.check.mockReset();
  mocks.update.setPreference.mockReset();
  mocks.index.indexProgressByJob = {};
  mocks.ocr.tasks = [];
  mocks.ocr.isSubmitting = false;
  mocks.ocr.bulkOcrRunning = false;
});

it('waits for active indexing before enabling installation', () => {
  mocks.index.indexProgressByJob = { 1: { status: 'running' } };
  const { rerender } = render(<UpdateSettings />);
  const install = screen.getByRole('button', { name: 'updates.install' });
  expect(install).toBeDisabled();
  expect(install).toHaveAttribute('title', 'updates.waitForTasks');
  mocks.index.indexProgressByJob = {};
  rerender(<UpdateSettings />);
  fireEvent.click(install);
  expect(mocks.update.install).toHaveBeenCalledOnce();
});

it('offers a retry download after a network failure and saves update preferences', () => {
  mocks.update.phase = 'available';
  mocks.update.error = 'network unavailable';
  render(<UpdateSettings />);
  expect(screen.getByText('network unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'updates.download' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'updates.autoDownload' }));
  expect(mocks.update.download).toHaveBeenCalledOnce();
  expect(mocks.update.setPreference).toHaveBeenCalledWith('updates_auto_download', false);
});
