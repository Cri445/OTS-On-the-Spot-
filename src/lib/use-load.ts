import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api';

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (data: T) => void;
}

/** Load something when the screen opens (and again whenever `deps` change). */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loader = useRef(load);
  loader.current = load;
  const run = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++run.current;
    try {
      const result = await loader.current();
      if (mine !== run.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (mine === run.current) setError(errorMessage(err));
    } finally {
      if (mine === run.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload, setData };
}

/** Re-render on a timer, so countdowns and "starts in 5 min" labels stay current. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
