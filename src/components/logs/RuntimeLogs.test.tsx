import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeLogSnapshot } from '../../types';
import { useUIStore } from '../../stores/uiStore';
import { RuntimeLogs } from './RuntimeLogs';

const read = vi.hoisted(() => vi.fn());
vi.mock('../../lib/tauri', () => ({ getRuntimeLogs: read }));
const snapshot = (line = '[INFO] ready', source = 'application'): RuntimeLogSnapshot => ({
  source: source as RuntimeLogSnapshot['source'], path: `${source}.log`, lines: [line], updated_at: null,
});
function pending() {
  let resolve!: (value: RuntimeLogSnapshot) => void;
  let reject!: (reason: string) => void;
  const promise = new Promise<RuntimeLogSnapshot>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('runtime log loading', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    read.mockReset();
    useUIStore.setState({ language: 'en' });
    Element.prototype.scrollTo = vi.fn();
  });
  afterEach(() => vi.useRealTimers());

  it('animates while slow I/O is pending and never overlaps polling or refresh', async () => {
    const request = pending();
    read.mockReturnValue(request.promise);
    render(<RuntimeLogs />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve(snapshot()));
    expect(screen.getByText('[INFO] ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(read).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('discards an old source response and serializes a source switch', async () => {
    const first = pending();
    read.mockReturnValueOnce(first.promise).mockResolvedValue(snapshot('[WARN] search', 'elasticsearch'));
    render(<RuntimeLogs />);
    fireEvent.click(screen.getByRole('tab', { name: 'Elasticsearch' }));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(snapshot('[INFO] stale')));
    expect(screen.queryByText('[INFO] stale')).not.toBeInTheDocument();
    expect(screen.getByText('[WARN] search')).toBeInTheDocument();
    expect(read).toHaveBeenLastCalledWith('elasticsearch', 800);
  });

  it('preserves the snapshot on pause and permits a manual refresh', async () => {
    read.mockResolvedValue(snapshot());
    await act(async () => { render(<RuntimeLogs />); });
    fireEvent.click(screen.getByRole('button', { name: 'Live' }));
    expect(screen.getByText('[INFO] ready')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('clears the loading state on failure and retries manually', async () => {
    const request = pending();
    read.mockReturnValueOnce(request.promise).mockResolvedValue(snapshot());
    render(<RuntimeLogs />);
    await act(async () => request.reject('disk busy'));
    expect(screen.getByRole('alert')).toHaveTextContent('disk busy');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('[INFO] ready')).toBeInTheDocument();
  });

  it('does not restart polling after unmount during a pending read', async () => {
    const request = pending();
    read.mockReturnValue(request.promise);
    const view = render(<RuntimeLogs />);
    view.unmount();
    await act(async () => request.resolve(snapshot()));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('filters by severity and text without another disk request', async () => {
    read.mockResolvedValue({ ...snapshot(), lines: ['[ERROR] broken disk', '[WARN] slow', '[INFO] ready'] });
    await act(async () => { render(<RuntimeLogs />); });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'error' } });
    expect(screen.queryByText('[WARN] slow')).not.toBeInTheDocument();
    expect(screen.getByText('[ERROR] broken disk')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing' } });
    expect(screen.queryByText('[ERROR] broken disk')).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
