import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { RelativeTime } from '@/components/common/badges';
import { groupNotifications, summarise, type NotificationGroup } from './grouping';
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
            {groupNotifications(list.data.items).map((group) => (
              <GroupRow
                key={group.id}
                group={group}
                onRead={(ids) => ids.forEach((id) => markRead.mutate(id))}
              />
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

/**
 * One line per task, opened if you want the detail.
 *
 * A single notification still renders as itself: the summary only earns its
 * place when there is more than one thing to summarise.
 */
function GroupRow({ group, onRead }: { group: NotificationGroup; onRead(ids: string[]): void }) {
  const [open, setOpen] = useState(false);
  const many = group.items.length > 1;
  const unreadIds = group.items.filter((item) => !item.readAt).map((item) => item.id);

  return (
    <li className={cn(group.unread === 0 && 'opacity-60')}>
      <div
        className={cn(
          'grid grid-cols-[10px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-3',
          'sm:grid-cols-[10px_minmax(0,1fr)_6rem_6.5rem]',
        )}
      >
        {group.unread > 0 ? (
          <span
            aria-label={group.unread + ' unread'}
            className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          />
        ) : (
          <span className="mt-2 h-1.5 w-1.5 shrink-0" />
        )}

        <div className="min-w-0">
          <Link
            to={notificationHref(group.latest)}
            onClick={() => unreadIds.length > 0 && onRead(unreadIds)}
            title={group.latest.title}
            className="block truncate text-sm font-medium hover:underline"
          >
            {group.latest.title}
          </Link>

          <p className="truncate text-xs text-ink-muted" title={summarise(group)}>
            {many ? (
              <button
                type="button"
                onClick={() => setOpen((shown) => !shown)}
                aria-expanded={open}
                className="hover:text-ink hover:underline"
              >
                {summarise(group)} {open ? '\u2212' : '+'}
              </button>
            ) : (
              summarise(group)
            )}
          </p>
        </div>

        <p className="text-[11px] whitespace-nowrap text-ink-faint sm:text-right">
          <RelativeTime iso={group.latest.createdAt} />
        </p>

        {unreadIds.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-end"
            onClick={() => onRead(unreadIds)}
          >
            {/* One press clears the whole group, which is what it looks like. */}
            {many ? 'Mark all read' : 'Mark read'}
          </Button>
        ) : (
          <span className="hidden sm:block" />
        )}
      </div>

      {open && many ? (
        <ul className="border-t border-border-subtle bg-surface-muted/40 px-4 py-2 pl-10">
          {group.items.map((item) => (
            <li key={item.id} className="flex items-baseline gap-2 py-1 text-xs">
              <Link
                to={notificationHref(item)}
                onClick={() => !item.readAt && onRead([item.id])}
                className="min-w-0 flex-1 truncate text-ink-muted hover:text-ink hover:underline"
              >
                {item.body ?? item.title}
              </Link>
              <RelativeTime iso={item.createdAt} className="shrink-0 text-ink-faint" />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
