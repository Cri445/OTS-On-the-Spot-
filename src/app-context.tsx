import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatMoney } from '../shared/money';
import type { AppConfig, Me } from '../shared/types';
import { api, errorMessage, post } from './api';
import { Intro, LogoMark, shouldPlayIntro } from './components/Logo';

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
  const [intro, setIntro] = useState(shouldPlayIntro);
  const endIntro = useCallback(() => setIntro(false), []);
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

  // The opening animation plays over whatever is underneath while the app loads.
  const opening = intro && <Intro onDone={endIntro} />;

  if (failed) {
    return (
      <div className="splash">
        <span className="logo-tile">
          <LogoMark size={34} />
        </span>
        <p>{failed}</p>
        <button className="btn btn--primary" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  }
  if (!value) {
    return (
      <>
        {opening}
        <div className="splash" role="status" aria-label="Loading OTS">
          <span className="logo-tile logo-tile--pulse">
            <LogoMark size={40} />
          </span>
        </div>
      </>
    );
  }
  return (
    <AppContext.Provider value={value}>
      {opening}
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
