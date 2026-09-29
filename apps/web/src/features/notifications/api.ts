import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, toQuery } from '@/lib/api';

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string | null;
  taskId: string | null;
  taskKey: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreference {
  type: string;
  inApp: boolean;
  email: boolean;
  digestOnly: boolean;
}

export const notificationKeys = {
  all: ['notifications'] as const,
  list: (unreadOnly: boolean) => ['notifications', 'list', unreadOnly] as const,
  unread: ['notifications', 'unread'] as const,
  preferences: ['notifications', 'preferences'] as const,
};

export function useNotifications(unreadOnly = false) {
  return useQuery({
    queryKey: notificationKeys.list(unreadOnly),
    queryFn: ({ signal }) =>
      api.get<{ items: NotificationView[]; unread: number }>(
        '/notifications' + toQuery({ unreadOnly: unreadOnly ? 'true' : undefined, limit: 30 }),
        signal,
      ),
  });
}

/**
 * The bell count. Kept as its own query so a socket event can update it without
 * refetching the whole list, and so a reconnect can refresh just this.
 */
export function useUnreadCount() {
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: ({ signal }) => api.get<{ unread: number }>('/notifications/unread-count', signal),
    staleTime: 15_000,
  });
}

export function useMarkRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ unread: number }>('/notifications/' + id + '/read'),
    onSuccess: (result) => {
      client.setQueryData(notificationKeys.unread, result);
      void client.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

export function useMarkAllRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ unread: number }>('/notifications/read-all'),
    onSuccess: (result) => {
      client.setQueryData(notificationKeys.unread, result);
      void client.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: notificationKeys.preferences,
    queryFn: ({ signal }) =>
      api.get<{ items: NotificationPreference[] }>('/notifications/preferences', signal),
  });
}

export function useSetPreference() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: string; inApp?: boolean; email?: boolean; digestOnly?: boolean }) =>
      api.put<{ items: NotificationPreference[] }>(
        '/notifications/preferences/' + input.type,
        input,
      ),
    onSuccess: (result) => client.setQueryData(notificationKeys.preferences, result),
  });
}
