import { Link } from 'react-router-dom';
import { Button, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { RelativeTime } from '@/components/common/badges';
import { cn } from '@/lib/utils';
import { notificationHref, useMarkAllRead, useMarkRead, useNotifications } from './api';

export function NotificationsPage() {
  const list = useNotifications(false);
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
        {list.data?.unread ? (
          <span className="text-sm text-ink-muted">{list.data.unread} unread</span>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/settings/notifications">Preferences</Link>
          </Button>
          {list.data?.unread ? (
            <Button size="sm" onClick={() => markAllRead.mutate()} disabled={markAllRead.isPending}>
              Mark all read
            </Button>
          ) : null}
        </div>
      </header>

      <Card>
        {list.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : list.data?.items.length ? (
          <ul className="divide-y divide-border-subtle">
            {list.data.items.map((notification) => (
              /*
                A grid rather than a flex row, so the dot, the text, the time
                and the button sit in the same four columns on every row
                whatever the length of the title.
              */
              <li
                key={notification.id}
                className={cn(
                  'grid grid-cols-[10px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-3',
                  'sm:grid-cols-[10px_minmax(0,1fr)_6rem_6.5rem]',
                  notification.readAt && 'opacity-60',
                )}
              >
                {!notification.readAt ? (
                  <span
                    aria-label="Unread"
                    className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  />
                ) : (
                  <span className="mt-2 h-1.5 w-1.5 shrink-0" />
                )}

                <div className="min-w-0">
                  <Link
                    to={notificationHref(notification)}
                    onClick={() => !notification.readAt && markRead.mutate(notification.id)}
                    title={notification.title}
                    className="block truncate text-sm font-medium hover:underline"
                  >
                    {notification.title}
                  </Link>
                  {notification.body ? (
                    <p title={notification.body} className="truncate text-xs text-ink-muted">
                      {notification.body}
                    </p>
                  ) : null}
                </div>

                <p className="text-[11px] whitespace-nowrap text-ink-faint sm:text-right">
                  <RelativeTime iso={notification.createdAt} />
                </p>

                {!notification.readAt ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="justify-self-end"
                    onClick={() => markRead.mutate(notification.id)}
                  >
                    Mark read
                  </Button>
                ) : (
                  <span className="hidden sm:block" />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Nothing here yet"
            description="Notifications about your work appear here."
          />
        )}
      </Card>
    </div>
  );
}
