import { useEffect, useRef, useState } from 'react';
import { getRuntimeLogs } from '../lib/tauri';
import type { RuntimeLogSnapshot, RuntimeLogSource } from '../types';

export function useRuntimeLogs(source: RuntimeLogSource, live: boolean) {
  const [snapshot, setSnapshot] = useState<RuntimeLogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<RuntimeLogSnapshot> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const liveRef = useRef(live);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let active = true;
    let busy = false;
    setSnapshot(null);
    setError(null);
    setLoading(true);

    const read = async () => {
      if (busy || !active) return;
      busy = true;
      clearTimeout(timer.current);
      setLoading(true);
      setError(null);
      // A source switch waits for the previous disk read instead of piling up I/O.
      if (inFlight.current) await inFlight.current.catch(() => {});
      if (!active) return;
      const request = getRuntimeLogs(source, 800);
      inFlight.current = request;
      try {
        const next = await request;
        if (active) setSnapshot(next);
      } catch (reason) {
        if (active) setError(String(reason));
      } finally {
        if (inFlight.current === request) inFlight.current = null;
        busy = false;
        if (active) {
          setLoading(false);
          clearTimeout(timer.current);
          if (liveRef.current) timer.current = setTimeout(() => void read(), 2000);
        }
      }
    };
    refreshRef.current = () => { void read(); };
    void read();
    return () => {
      active = false;
      clearTimeout(timer.current);
      refreshRef.current = () => {};
    };
  }, [source]);

  useEffect(() => {
    liveRef.current = live;
    clearTimeout(timer.current);
    if (live) timer.current = setTimeout(() => refreshRef.current(), 2000);
  }, [live]);

  return { snapshot, loading, error, refresh: () => refreshRef.current() };
}
