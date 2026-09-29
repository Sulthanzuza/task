import { Link } from 'react-router-dom';
import { Button, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { relativeTime } from '@/lib/utils';
import { useMarkAllRead, useMarkRead, useNotifications } from './api';

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
              <li
                key={notification.id}
                className={
                  'flex items-start gap-3 px-4 py-3 ' + (notification.readAt ? 'opacity-60' : '')
                }
              >
                {!notification.readAt ? (
                  <span aria-label="Unread" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                ) : (
                  <span className="mt-2 h-1.5 w-1.5 shrink-0" />
                )}

                <div className="min-w-0 flex-1">
                  {notification.taskKey ? (
                    <Link
                      to={'/tasks/' + notification.taskKey}
                      onClick={() => !notification.readAt && markRead.mutate(notification.id)}
                      className="block truncate text-sm font-medium hover:underline"
                    >
                      {notification.title}
                    </Link>
                  ) : (
                    <span className="block truncate text-sm font-medium">{notification.title}</span>
                  )}
                  {notification.body ? (
                    <p className="truncate text-xs text-ink-muted">{notification.body}</p>
                  ) : null}
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    {relativeTime(notification.createdAt)}
                  </p>
                </div>

                {!notification.readAt ? (
                  <Button variant="ghost" size="sm" onClick={() => markRead.mutate(notification.id)}>
                    Mark read
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Nothing here yet" description="Notifications about your work appear here." />
        )}
      </Card>
    </div>
  );
}
