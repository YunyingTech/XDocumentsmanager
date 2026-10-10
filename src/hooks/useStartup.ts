import { useEffect, useState } from 'react';
import { getStartupStatus } from '../lib/tauri';
import type { StartupStatus } from '../types';

export function useStartup(): StartupStatus {
  const [status, setStatus] = useState<StartupStatus>({ phase: 'database', ready: false, error: null });
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getStartupStatus();
        if (!active) return;
        setStatus(next);
        if (!next.ready && next.phase !== 'failed') timer = setTimeout(() => void poll(), 500);
      } catch (reason) {
        if (active) setStatus({ phase: 'failed', ready: false, error: String(reason) });
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  return status;
}
