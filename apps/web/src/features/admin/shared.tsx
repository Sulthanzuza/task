import { useCallback, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthContext';

import { cn } from '@/lib/utils';

/** The furniture every admin screen shares: the tabs, a heading, a message strip. */

interface AdminTab {
  to: string;
  label: string;
  adminOnly: boolean;
}

const TABS: AdminTab[] = [
  { to: '/admin/people', label: 'People', adminOnly: true },
  { to: '/admin/teams', label: 'Teams', adminOnly: true },
  // A lead runs their own team's projects, so this one is not admin-only.
  { to: '/admin/projects', label: 'Projects', adminOnly: false },
  { to: '/settings/organisation', label: 'Organisation', adminOnly: true },
  { to: '/settings/holidays', label: 'Holidays', adminOnly: true },
  { to: '/settings/email', label: 'Email', adminOnly: true },
  { to: '/admin/import', label: 'Import', adminOnly: false },
  { to: '/admin/audit', label: 'Audit', adminOnly: true },
];

export function AdminTabs() {
  const { isAdmin } = useAuth();
  const tabs = TABS.filter((tab) => isAdmin || !tab.adminOnly);

  return (
    <nav aria-label="Administration" className="-mx-1 flex gap-1 overflow-x-auto pb-1">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          className={({ isActive }) =>
            cn(
              'rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors',
              isActive
                ? 'bg-accent-soft font-medium text-accent'
                : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
            )
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function AdminPage({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 sm:px-6">
      <AdminTabs />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>
          ) : null}
        </div>
        {action}
      </div>

      {children}
    </div>
  );
}

export type BannerTone = 'success' | 'error' | 'info';

export interface BannerState {
  tone: BannerTone;
  message: string;
}

/**
 * One place for "that worked" and "that did not".
 *
 * It is announced politely rather than shouted, because most of these follow a
 * button the person just pressed and they are already looking at it.
 */
export function Banner({ state, onDismiss }: { state: BannerState | null; onDismiss(): void }) {
  if (!state) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-start gap-3 rounded-lg px-3 py-2 text-sm',
        state.tone === 'success' && 'bg-success-soft text-success',
        state.tone === 'error' && 'bg-danger-soft text-danger',
        state.tone === 'info' && 'bg-surface-muted text-ink-muted',
      )}
    >
      <span className="flex-1">{state.message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0">
        ×
      </button>
    </div>
  );
}

export function useBanner() {
  const [state, setState] = useState<BannerState | null>(null);

  const show = useCallback((tone: BannerTone, message: string) => {
    setState({ tone, message });
  }, []);

  const clear = useCallback(() => setState(null), []);

  return {
    show,
    clear,
    state,
    props: { state, onDismiss: clear },
  };
}

/**
 * A labelled control, with the error where the eye already is.
 *
 * The label wraps the control rather than pointing at an id, so every field
 * gets the association for free and none can be left unlabelled by a missing
 * htmlFor. The hint sits outside the label, so it does not become part of the
 * name a screen reader announces.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-ink-muted">{label}</span>
        {children}
      </label>
      {hint ? <p className="mt-1 text-xs text-ink-faint">{hint}</p> : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
