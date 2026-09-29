import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  NotificationEvent,
  NotificationReadEvent,
  TaskChangedEvent,
  TaskDeletedEvent,
  TaskDetail,
} from '@tm/shared';
import { connectSocket, disconnectSocket } from '@/lib/socket';
import { isOwnMutation } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { notificationKeys } from '@/features/notifications/api';
import { useAuth } from '@/features/auth/AuthContext';

/**
 * Keeps the query cache in step with what other people are doing.
 *
 * Three rules keep this from causing more trouble than it solves:
 *
 * 1. A tab ignores the echo of its own change. The optimistic update already
 *    applied it, and re-applying would make the card flicker.
 * 2. An event older than what the cache holds is dropped, so a slow event
 *    cannot undo a newer one that arrived first.
 * 3. A reconnect invalidates once instead of replaying whatever was missed.
 */
export function useRealtime(): void {
  const client = useQueryClient();
  const { user, signOut } = useAuth();

  // Held in a ref so the socket's handlers always see the current client
  // without the effect needing to tear down and reconnect.
  const lastSeen = useRef(new Map<string, number>());

  useEffect(() => {
    if (!user) return;

    const seen = lastSeen.current;

    /** True when this event is older than something already applied. */
    const isStale = (taskId: string, updatedAt: string): boolean => {
      const stamp = Date.parse(updatedAt);
      if (Number.isNaN(stamp)) return false;

      const previous = seen.get(taskId);
      if (previous !== undefined && stamp <= previous) return true;

      // Also compare against what the cache already holds, which may be newer
      // than anything this tab has seen over the wire.
      const cached =
        client.getQueryData<TaskDetail>(queryKeys.tasks.detail(taskId)) ??
        undefined;
      if (cached && Date.parse(cached.updatedAt) > stamp) return true;

      seen.set(taskId, stamp);
      return false;
    };

    const socket = connectSocket({
      onTaskChanged(event: TaskChangedEvent) {
        if (isOwnMutation(event.clientMutationId)) return;
        if (isStale(event.taskId, event.updatedAt)) return;

        // Refetch rather than patch: the event says what changed, not the whole
        // row, and a board card shows fields no event carries.
        void client.invalidateQueries({ queryKey: queryKeys.tasks.detail(event.taskId) });
        void client.invalidateQueries({ queryKey: queryKeys.tasks.detail(event.taskKey) });
        void client.invalidateQueries({ queryKey: ['tasks', 'list'] });
        void client.invalidateQueries({ queryKey: queryKeys.tasks.timeline(event.taskKey) });
        void client.invalidateQueries({ queryKey: queryKeys.dashboard.all });
      },

      onTaskDeleted(event: TaskDeletedEvent) {
        if (isOwnMutation(event.clientMutationId)) return;
        seen.delete(event.taskId);
        void client.invalidateQueries({ queryKey: ['tasks', 'list'] });
        void client.invalidateQueries({ queryKey: queryKeys.dashboard.all });
      },

      onNotification(event: NotificationEvent) {
        // The count comes from the event, so the bell moves without a refetch.
        client.setQueryData(notificationKeys.unread, { unread: event.unread });
        void client.invalidateQueries({ queryKey: notificationKeys.all });
      },

      onNotificationRead(event: NotificationReadEvent) {
        // Sent to every tab of this person's, which is what keeps them in step.
        client.setQueryData(notificationKeys.unread, { unread: event.unread });
        void client.invalidateQueries({ queryKey: notificationKeys.all });
      },

      onReconnect() {
        // Whatever happened while we were away, one refetch settles it.
        seen.clear();
        void client.invalidateQueries({ queryKey: queryKeys.tasks.all });
        void client.invalidateQueries({ queryKey: queryKeys.dashboard.all });
        // One call to catch up the bell, rather than replaying what was missed.
        void client.invalidateQueries({ queryKey: notificationKeys.unread });
      },

      onSessionRevoked() {
        void signOut();
      },
    });

    return () => {
      socket.off();
      disconnectSocket();
    };
  }, [user, client, signOut]);
}
