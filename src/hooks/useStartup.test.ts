import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStartup } from './useStartup';
import type { StartupStatus } from '../types';

const read = vi.hoisted(() => vi.fn());
vi.mock('../lib/tauri', () => ({ getStartupStatus: read }));
beforeEach(() => { vi.useFakeTimers(); read.mockReset(); });
afterEach(() => vi.useRealTimers());

it('polls progress until ready, including optional search failure', async () => {
  read.mockResolvedValueOnce({ phase: 'search_sync', ready: false, error: null })
    .mockResolvedValue({ phase: 'ready', ready: true, error: 'search unavailable' });
  const { result } = renderHook(useStartup);
  expect(result.current.ready).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(result.current.phase).toBe('search_sync');
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(result.current.ready).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(['backend', 'transport'])('stops the loading animation after %s failure', async (failure) => {
  if (failure === 'backend') read.mockResolvedValue({ phase: 'failed', ready: false, error: 'database failed' });
  else read.mockRejectedValue('database failed');
  const { result } = renderHook(useStartup);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(result.current).toEqual({ phase: 'failed', ready: false, error: 'database failed' });
  expect(read).toHaveBeenCalledTimes(1);
});

it('does not overlap slow status requests and stops on unmount', async () => {
  let resolve!: (status: StartupStatus) => void;
  read.mockReturnValue(new Promise<StartupStatus>((yes) => { resolve = yes; }));
  const { unmount } = renderHook(useStartup);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(read).toHaveBeenCalledTimes(1);
  unmount();
  await act(async () => resolve({ phase: 'database', ready: false, error: null }));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(read).toHaveBeenCalledTimes(1);
});
