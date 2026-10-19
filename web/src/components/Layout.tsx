import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useRealtime } from '../realtime/useRealtime';
import { NewItemDialog } from './NewItemDialog';
import { NotificationsBell } from './NotificationsBell';

const liveText = { live: 'Live', connecting: 'Connecting…', offline: 'Reconnecting…' } as const;

export function Layout() {
  const { user, teams, logout } = useAuth();
  const live = useRealtime(true);
  const [creating, setCreating] = useState(false);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">OpsDesk</div>
        <nav className="nav">
          <NavLink to="/" end>
            Needs attention
          </NavLink>
          <NavLink to="/items">All work</NavLink>
        </nav>
        <div className="topbar-right">
          <span className={`live live-${live}`} title="Updates from other people appear automatically">
            <span className="dot" /> {liveText[live]}
          </span>
          {teams.length > 0 && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              New item
            </button>
          )}
          <NotificationsBell />
          <span className="who">{user?.name}</span>
          <button className="btn btn-ghost" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        <Outlet />
      </main>

      {creating && <NewItemDialog onClose={() => setCreating(false)} />}
    </div>
  );
}