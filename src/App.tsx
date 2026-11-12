import type { ReactNode } from 'react';
import { Compass, Plus, Ticket, User, Wallet as WalletIcon } from 'lucide-react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { useApp } from './app-context';
import { Avatar, Empty } from './components/ui';
import { ActivityPage } from './pages/ActivityPage';
import { Admin } from './pages/Admin';
import { AuthPage } from './pages/AuthPage';
import { Checkin } from './pages/Checkin';
import { DoorList } from './pages/DoorList';
import { Explore } from './pages/Explore';
import { GroupLobby } from './pages/GroupLobby';
import { HostForm } from './pages/HostForm';
import { Hosting } from './pages/Hosting';
import { Profile } from './pages/Profile';
import { Tickets } from './pages/Tickets';
import { Wallet } from './pages/Wallet';

function Shell() {
  const { user, config } = useApp();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand" aria-label="OTS — On the Spot, home">
          <span className="logo-mark" aria-hidden />
          <span className="brand__name">OTS</span>
          <span className="brand__tag">On the Spot</span>
        </Link>
        <nav className="topnav" aria-label="Main">
          <NavLink to="/" end>
            Explore
          </NavLink>
          <NavLink to="/tickets">My tickets</NavLink>
          <NavLink to="/hosting">Hosting</NavLink>
          <NavLink to="/wallet">Wallet</NavLink>
          {user?.isAdmin && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="topbar__right">
          {config.demoMode && (
            <span className="demo-chip" title="Payments and ID checks are simulated. No real money moves.">
              Demo
            </span>
          )}
          <Link to="/host" className="btn btn--spot btn--sm topbar__host">
            <Plus size={16} aria-hidden /> Host an activity
          </Link>
          {user ? (
            <Link to="/profile" className="topbar__me" aria-label="Your profile">
              <Avatar name={user.displayName} color={user.avatarColor} size={34} />
            </Link>
          ) : (
            <Link to="/login" className="btn btn--ghost btn--sm">
              Log in
            </Link>
          )}
        </div>
      </header>

      <main className="main">
        <Outlet />
      </main>

      <nav className="tabbar" aria-label="Main">
        <NavLink to="/" end>
          <Compass size={22} aria-hidden />
          <span>Explore</span>
        </NavLink>
        <NavLink to="/tickets">
          <Ticket size={22} aria-hidden />
          <span>Tickets</span>
        </NavLink>
        <NavLink to="/host" className="tabbar__host">
          <span className="tabbar__plus">
            <Plus size={22} aria-hidden />
          </span>
          <span>Host</span>
        </NavLink>
        <NavLink to="/wallet">
          <WalletIcon size={22} aria-hidden />
          <span>Wallet</span>
        </NavLink>
        <NavLink to={user ? '/profile' : '/login'}>
          <User size={22} aria-hidden />
          <span>{user ? 'Profile' : 'Log in'}</span>
        </NavLink>
      </nav>
    </div>
  );
}

/** Screens that need an account send visitors to log in, then bring them straight back. */
function Private({ children }: { children: ReactNode }) {
  const { user } = useApp();
  const location = useLocation();
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return children;
}

function NotFound() {
  return (
    <div className="page">
      <Empty emoji="🧭" title="Nothing on this spot">
        <p>That page doesn't exist — it may have moved or the link is wrong.</p>
        <Link to="/" className="btn btn--primary">
          Back to the map
        </Link>
      </Empty>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Explore />} />
        <Route path="a/:id" element={<ActivityPage />} />
        <Route path="a/:id/door" element={<Private><DoorList /></Private>} />
        <Route path="a/:id/edit" element={<Private><HostForm /></Private>} />
        <Route path="host" element={<Private><HostForm /></Private>} />
        <Route path="hosting" element={<Private><Hosting /></Private>} />
        <Route path="tickets" element={<Private><Tickets /></Private>} />
        <Route path="g/:code" element={<Private><GroupLobby /></Private>} />
        <Route path="wallet" element={<Private><Wallet /></Private>} />
        <Route path="profile" element={<Private><Profile /></Private>} />
        <Route path="checkin/:code" element={<Private><Checkin /></Private>} />
        <Route path="admin" element={<Private><Admin /></Private>} />
        <Route path="login" element={<AuthPage mode="login" />} />
        <Route path="signup" element={<AuthPage mode="signup" />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
