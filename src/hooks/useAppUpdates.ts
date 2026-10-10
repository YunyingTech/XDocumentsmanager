import { useEffect } from 'react';
import { useUpdateStore } from '../stores/updateStore';

export function useAppUpdates(ready: boolean) {
  const initialize = useUpdateStore((state) => state.initialize);
  const refresh = useUpdateStore((state) => state.refresh);
  useEffect(() => {
    if (!ready) return;
    void initialize();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => window.clearInterval(timer);
  }, [ready, initialize, refresh]);
}
