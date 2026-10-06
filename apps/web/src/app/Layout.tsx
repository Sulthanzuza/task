import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  CalendarDays,
  ChartNoAxesColumn,
  CheckCircle2,
  ChevronDown,
  Gauge,
  KanbanSquare,
  ListTodo,
  LogOut,
  Menu,
  Search,
  Settings,
  Shield,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '@/features/auth/AuthContext';
import { useRealtime } from '@/features/realtime/useRealtime';
import { NotificationBell } from '@/features/notifications/NotificationBell';
import { ThemeSwitch } from './ThemeSwitch';
import { PeriodSwitcher } from './PeriodSwitcher';
import { Button } from '@/components/ui/primitives';
import { UserAvatar } from '@/components/common/badges';
import { ROLE_LABELS } from '@tm/shared';
import { cn } from '@/lib/utils';

/**
 * The top bar from the reference: name on the left, pill navigation in the
 * middle, controls on the right.
 *
 * Below 900px the pills do not shrink into something unusable; they move into a
 * sheet behind a menu button, which is the only honest way to fit eight
 * destinations on a phone.
 */

interface NavItem {
  to: string;
  label: string;
  icon: typeof Gauge;
  leadOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: Gauge, leadOnly: true },
  { to: '/my-tasks', label: 'My tasks', icon: CheckCircle2 },
  { to: '/tasks', label: 'Tasks', icon: ListTodo },
  { to: '/board', label: 'Board', icon: KanbanSquare },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/team', label: 'Team', icon: Users },
  { to: '/workload', label: 'Workload', icon: ChartNoAxesColumn, leadOnly: true },
  { to: '/reports', label: 'Reports', icon: ChartNoAxesColumn, leadOnly: true },
];

interface MoreItem {
  to: string;
  label: string;
  adminOnly?: boolean;
  leadOnly?: boolean;
}

const MORE: MoreItem[] = [
  { to: '/settings/notifications', label: 'Notification preferences' },
  { to: '/admin/projects', label: 'Projects', leadOnly: true },
  { to: '/admin/import', label: 'Import', leadOnly: true },
  { to: '/admin/people', label: 'People', adminOnly: true },
  { to: '/admin/teams', label: 'Teams', adminOnly: true },
  { to: '/settings/organisation', label: 'Organisation', adminOnly: true },
  { to: '/settings/holidays', label: 'Holidays', adminOnly: true },
  { to: '/settings/email', label: 'Email', adminOnly: true },
  { to: '/admin/audit', label: 'Audit', adminOnly: true },
];

const pillClass = (isActive: boolean) =>
  cn(
    'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1.5 text-[13px] whitespace-nowrap transition-all',
    isActive
      ? 'accent-gradient font-medium text-[var(--color-accent-ink)] shadow-[0_6px_16px_-8px_var(--color-accent)]'
      : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
  );

export function Layout() {
  const { signOut, isLead, isAdmin } = useAuth();

  // One socket for the whole signed-in session, opened here rather than per
  // screen so navigating does not reconnect.
  useRealtime();

  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const items = NAV.filter((item) => !item.leadOnly || isLead);
  const moreItems = MORE.filter(
    (item) => (!item.adminOnly || isAdmin) && (!item.leadOnly || isLead),
  );

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-border-subtle bg-[var(--color-canvas)]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center gap-3 px-4 sm:px-6">
          {/*
            Named on the link itself. The wordmark beside it disappears below
            1366, and without this the only link on the page announced as a
            bare URL was the one back to the dashboard.
          */}
          <NavLink
            to="/"
            aria-label="Task Manager, dashboard"
            className="flex shrink-0 items-center gap-2"
          >
            <span className="accent-gradient flex h-8 w-8 items-center justify-center rounded-xl text-[var(--color-accent-ink)]">
              <Shield size={16} aria-hidden />
            </span>
            {/* The mark alone below 1366: the navigation needs the room. */}
            <span className="hidden text-sm font-semibold tracking-tight min-[1366px]:block">
              Task Manager
            </span>
          </NavLink>

          {/*
            The pills. Hidden below 900px, where the sheet takes over. Allowed
            to shrink and scroll rather than push the bar wider than the
            window: eight destinations and a full set of controls do not fit a
            1280px screen at their natural width.
          */}
          <nav
            aria-label="Main"
            className={cn(
              'mx-auto hidden min-w-0 items-center gap-0.5 rounded-full',
              'border border-border-subtle bg-surface/70 p-1 min-[900px]:flex',
            )}
          >
            {/*
              Only the pills scroll. The More menu stays outside this box: an
              overflow container clips both axes, so a dropdown inside it
              opened invisibly within the bar.
            */}
            <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => pillClass(isActive)}
                >
                  <item.icon size={14} aria-hidden />
                  {item.label}
                </NavLink>
              ))}
            </div>
            {moreItems.length > 0 ? <MoreMenu items={moreItems} /> : null}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-1 min-[900px]:ml-0">
            <PeriodSwitcher />

            <NavLink
              to="/tasks"
              aria-label="Search tasks"
              className="rounded-full p-2 text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
            >
              <Search size={17} />
            </NavLink>

            <NotificationBell />
            <ThemeSwitch />

            <AccountMenu
              onSignOut={() => {
                void signOut().then(() => navigate('/login'));
              }}
            />

            <Button
              variant="ghost"
              size="icon"
              className="min-[900px]:hidden"
              aria-label="Open menu"
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={18} />
            </Button>
          </div>
        </div>
      </header>

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>

      {menuOpen ? (
        <MenuSheet
          items={items}
          moreItems={moreItems}
          onClose={() => setMenuOpen(false)}
          onSignOut={() => {
            setMenuOpen(false);
            void signOut().then(() => navigate('/login'));
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The account menu.
 *
 * Below 1440px the name and role come off the bar to leave the navigation
 * whole, so the menu carries them at its top: an avatar on its own does not
 * tell you which account you are signed in to, and on a shared machine that
 * matters.
 */
function AccountMenu({ onSignOut }: { onSignOut(): void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative ml-1 hidden shrink-0 sm:block">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={'Account: ' + (user?.name ?? '')}
        onClick={() => setOpen((shown) => !shown)}
        className="flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-surface-muted"
      >
        <UserAvatar user={user ? { ...user, isActive: true } : null} />
        <span className="hidden leading-tight min-[1440px]:block">
          <span className="block max-w-32 truncate text-xs font-medium">{user?.name}</span>
          <span className="block text-[11px] text-ink-faint">
            {user ? ROLE_LABELS[user.role] : ''}
          </span>
        </span>
        <ChevronDown size={13} aria-hidden className="mr-1 text-ink-faint" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-50 mt-2 w-56 rounded-2xl border border-border-subtle bg-surface p-1.5 shadow-[var(--shadow-lift)]"
        >
          <div className="border-b border-border-subtle px-3 pt-1.5 pb-2.5">
            <p className="truncate text-sm font-medium">{user?.name}</p>
            <p className="truncate text-xs text-ink-faint">{user?.email}</p>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              {user ? ROLE_LABELS[user.role] : ''}
            </p>
          </div>

          <NavLink
            to={'/team/' + (user?.id ?? '')}
            role="menuitem"
            onClick={() => setOpen(false)}
            className="mt-1 block rounded-xl px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-muted"
          >
            My page
          </NavLink>

          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-ink-muted transition-colors hover:bg-surface-muted"
          >
            <LogOut size={14} aria-hidden />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Settings and administration, kept out of the main run of pills. */
function MoreMenu({ items }: { items: MoreItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
        className={pillClass(false)}
      >
        <Settings size={14} aria-hidden />
        {/* The word is the first thing to go when the bar is tight. */}
        <span className="hidden min-[1200px]:inline">More</span>
        <ChevronDown size={13} aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Settings and administration"
          className="absolute right-0 z-50 mt-2 w-60 rounded-2xl border border-border-subtle bg-surface p-1.5 shadow-[var(--shadow-lift)]"
        >
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  'block rounded-xl px-3 py-2 text-sm transition-colors',
                  isActive ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-surface-muted',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Below 900px every destination lives here. */
function MenuSheet({
  items,
  moreItems,
  onClose,
  onSignOut,
}: {
  items: NavItem[];
  moreItems: MoreItem[];
  onClose(): void;
  onSignOut(): void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 min-[900px]:hidden"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className="ml-auto flex h-full w-72 max-w-[85vw] flex-col overflow-y-auto border-l border-border-subtle bg-surface p-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold">Menu</span>
          <Button variant="ghost" size="icon" aria-label="Close menu" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>

        <nav aria-label="Main" className="space-y-1">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-colors',
                  isActive
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-ink-muted hover:bg-surface-muted',
                )
              }
            >
              <item.icon size={16} aria-hidden />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {moreItems.length > 0 ? (
          <>
            <p className="mt-4 mb-1 px-3 text-[11px] font-medium tracking-wide text-ink-faint uppercase">
              Settings
            </p>
            <nav aria-label="Settings and administration" className="space-y-1">
              {moreItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={onClose}
                  className={({ isActive }) =>
                    cn(
                      'block rounded-xl px-3 py-2 text-sm transition-colors',
                      isActive
                        ? 'bg-accent-soft font-medium text-accent'
                        : 'text-ink-muted hover:bg-surface-muted',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </>
        ) : null}

        <Button variant="outline" className="mt-auto w-full" onClick={onSignOut}>
          <LogOut size={15} aria-hidden /> Sign out
        </Button>
      </div>
    </div>
  );
}
