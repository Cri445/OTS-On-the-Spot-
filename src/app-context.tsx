import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatMoney } from '../shared/money';
import type { AppConfig, Me } from '../shared/types';
import { api, errorMessage, post } from './api';

type ToastKind = 'ok' | 'error' | 'info';
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface AppState {
  config: AppConfig;
  user: Me | null;
  setUser: (user: Me | null) => void;
  logout: () => Promise<void>;
  toast: (text: string, kind?: ToastKind) => void;
  /** Format an amount of cents in the app's currency. */
  money: (cents: number) => string;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error('useApp must be used inside <AppProvider>');
  return state;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [user, setUser] = useState<Me | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    Promise.all([api<AppConfig>('/config'), api<{ user: Me | null }>('/me')])
      .then(([c, me]) => {
        setConfig(c);
        setUser(me.user);
      })
      .catch((err) => setFailed(errorMessage(err)));
  }, []);

  const toast = useCallback((text: string, kind: ToastKind = 'ok') => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4500);
  }, []);

  const logout = useCallback(async () => {
    await post('/auth/logout');
    setUser(null);
  }, []);

  const value = useMemo<AppState | null>(
    () => (config ? { config, user, setUser, logout, toast, money: (cents) => formatMoney(cents, config.currency) } : null),
    [config, user, logout, toast],
  );

  if (failed) {
    return (
      <div className="splash">
        <div className="logo-mark" aria-hidden />
        <p>{failed}</p>
        <button className="btn btn--primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  }
  if (!value) {
    return (
      <div className="splash" role="status" aria-label="Loading OTS">
        <div className="logo-mark logo-mark--pulse" aria-hidden />
      </div>
    );
  }
  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
