import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { Button, Card, EmptyState, Spinner } from '@/components/ui/primitives';
import { RelativeTime } from '@/components/common/badges';
import {
  notificationHref,
  useMarkAllRead,
  useMarkRead,
  useNotifications,
  useUnreadCount,
  type NotificationView,
} from './api';

/**
 * The bell.
 *
 * The count is its own query, updated by socket events, so marking something
 * read in one tab clears the badge in every tab without a refetch.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  const list = useNotifications(false);
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const navigate = useNavigate();
  const panel = useRef<HTMLDivElement>(null);

  // Clicking away or pressing Escape closes the panel, as a menu should.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
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

  const count = unread.data?.unread ?? 0;

  function openNotification(notification: NotificationView) {
    if (!notification.readAt) markRead.mutate(notification.id);
    setOpen(false);
    navigate(notificationHref(notification));
  }

  return (
    <div className="relative" ref={panel}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={count > 0 ? count + ' unread notifications' : 'Notifications'}
        aria-expanded={open}
        data-testid="notification-bell"
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={17} />
        {count > 0 ? (
          <span
            data-testid="notification-count"
            // The ink paired with --color-danger; see index.css.
            className="absolute top-1 right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-[var(--color-danger-ink)]"
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </Button>

      {open ? (
        <Card className="absolute right-0 z-50 mt-1 w-80 overflow-hidden shadow-lg sm:w-96">
          <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
            <span className="text-xs font-semibold">Notifications</span>
            {count > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => markAllRead.mutate()}
                disabled={markAllRead.isPending}
              >
                Mark all read
              </Button>
            ) : null}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {list.isLoading ? (
              <div className="flex justify-center py-8">
                <Spinner className="text-accent" />
              </div>
            ) : list.data?.items.length ? (
              <ul className="divide-y divide-border-subtle">
                {list.data.items.map((notification) => (
                  <li key={notification.id}>
                    <button
                      type="button"
                      data-testid="notification-item"
                      onClick={() => openNotification(notification)}
                      className={
                        'block w-full px-3 py-2.5 text-left transition-colors hover:bg-surface-muted ' +
                        (notification.readAt ? 'opacity-60' : '')
                      }
                    >
                      <span className="flex items-start gap-2">
                        {!notification.readAt ? (
                          <span
                            aria-label="Unread"
                            className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                          />
                        ) : (
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {notification.title}
                          </span>
                          {notification.body ? (
                            <span className="block truncate text-xs text-ink-muted">
                              {notification.body}
                            </span>
                          ) : null}
                          <span className="mt-0.5 block text-[11px] text-ink-faint">
                            <RelativeTime iso={notification.createdAt} />
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing new" description="You are up to date." />
            )}
          </div>

          <div className="border-t border-border-subtle px-3 py-2 text-center">
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs text-ink-muted hover:text-accent hover:underline"
            >
              See all notifications
            </Link>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
