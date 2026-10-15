import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const initialize = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('../stores/updateStore', () => ({ useUpdateStore: (selector: (state: { initialize: typeof initialize; refresh: typeof refresh }) => unknown) => selector({ initialize, refresh }) }));
import { useAppUpdates } from './useAppUpdates';

beforeEach(() => { vi.useFakeTimers(); initialize.mockReset(); refresh.mockReset(); });

it('initializes once the application is ready and refreshes update status', async () => {
  const { rerender, unmount } = renderHook(({ ready }) => useAppUpdates(ready), { initialProps: { ready: false } });
  expect(initialize).not.toHaveBeenCalled();
  rerender({ ready: true });
  expect(initialize).toHaveBeenCalledOnce();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(refresh).toHaveBeenCalledTimes(2);
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(refresh).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
