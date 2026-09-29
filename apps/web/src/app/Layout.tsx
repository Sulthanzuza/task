import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  CalendarDays,
  ChartNoAxesColumn,
  CircleUser,
  FolderKanban,
  Gauge,
  KanbanSquare,
  ListTodo,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useRealtime } from '@/features/realtime/useRealtime';
import { NotificationBell } from '@/features/notifications/NotificationBell';
import { Button } from '@/components/ui/primitives';
import { UserAvatar } from '@/components/common/badges';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Gauge;
  leadOnly?: boolean;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: Gauge, leadOnly: true },
  { to: '/my-tasks', label: 'My tasks', icon: ListTodo },
  { to: '/tasks', label: 'Tasks', icon: ListTodo },
  { to: '/board', label: 'Board', icon: KanbanSquare },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/team', label: 'Team', icon: Users },
  { to: '/workload', label: 'Workload', icon: ChartNoAxesColumn, leadOnly: true },
  { to: '/reports', label: 'Reports', icon: ChartNoAxesColumn, leadOnly: true },
  { to: '/admin/projects', label: 'Projects', icon: FolderKanban, leadOnly: true },
  { to: '/admin/people', label: 'People', icon: UserCog, adminOnly: true },
  { to: '/settings', label: 'Settings', icon: Settings },
];

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const stored = localStorage.getItem('tm-theme');
      if (stored) return stored === 'dark';
    } catch {
      // Private browsing can block storage; fall back to the system preference.
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('tm-theme', dark ? 'dark' : 'light');
    } catch {
      // Not being able to remember the choice is not worth breaking the page over.
    }
  }, [dark]);

  return [dark, setDark] as const;
}

export function Layout() {
  const { user, signOut, isLead, isAdmin } = useAuth();

  // One socket for the whole signed-in session, opened here rather than per
  // screen so navigating does not reconnect.
  useRealtime();

  const navigate = useNavigate();
  const [dark, setDark] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  const items = NAV.filter((item) => (!item.leadOnly || isLead) && (!item.adminOnly || isAdmin));

  return (
    <div className="flex h-full">
      {/* The sidebar slides in on a phone and is always present from md up. */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-border-subtle bg-surface',
          'transition-transform md:static md:translate-x-0',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center justify-between px-4">
          <span className="text-sm font-semibold tracking-tight">Task Manager</span>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
          >
            <X size={16} />
          </Button>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
                )
              }
            >
              <item.icon size={16} aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-border-subtle p-3">
          <div className="flex items-center gap-2">
            <UserAvatar user={user ? { ...user, isActive: true } : null} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user?.name}</p>
              <p className="truncate text-xs text-ink-faint">
                {user?.role === 'SUPER_ADMIN'
                  ? 'Super admin'
                  : user?.role === 'TEAM_LEAD'
                    ? 'Team lead'
                    : 'Member'}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              onClick={() => {
                void signOut().then(() => navigate('/login'));
              }}
            >
              <LogOut size={16} />
            </Button>
          </div>
        </div>
      </aside>

      {menuOpen ? (
        <button
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          aria-label="Close menu"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border-subtle bg-surface px-4">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={18} />
          </Button>

          <div className="relative hidden max-w-sm flex-1 sm:block">
            <Search
              size={15}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
              aria-hidden
            />
            <input
              type="search"
              placeholder="Search tasks (Ctrl+K)"
              className="h-9 w-full rounded-lg border border-border-subtle bg-canvas pr-3 pl-9 text-sm placeholder:text-ink-faint"
              onFocus={(event) => event.currentTarget.blur()}
              readOnly
              title="Global search arrives with the search and saved views work"
            />
          </div>

          <div className="ml-auto flex items-center gap-1">
            <NotificationBell />
            <Button
              variant="ghost"
              size="icon"
              aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </Button>
            <NavLink to={'/team/' + (user?.id ?? '')} aria-label="My page">
              <Button variant="ghost" size="icon">
                <CircleUser size={17} />
              </Button>
            </NavLink>
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
