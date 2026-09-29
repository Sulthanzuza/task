import { useQuery } from '@tanstack/react-query';
import type {
  AttentionItem,
  DashboardSummary,
  MemberActivityEntry,
  MemberRow,
  MemberStats,
} from '@tm/shared';
import { api, toQuery } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useDashboardSummary(teamId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboard.summary(teamId),
    queryFn: ({ signal }) =>
      api.get<DashboardSummary>('/dashboard/summary' + toQuery({ teamId }), signal),
    enabled,
  });
}

export function useDashboardMembers(teamId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboard.members(teamId),
    queryFn: ({ signal }) =>
      api.get<{ items: MemberRow[] }>('/dashboard/members' + toQuery({ teamId }), signal),
    enabled,
  });
}

export function useAttention(teamId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboard.attention(teamId),
    queryFn: ({ signal }) =>
      api.get<{ items: AttentionItem[] }>(
        '/dashboard/attention' + toQuery({ teamId, limit: 10 }),
        signal,
      ),
    enabled,
  });
}

export function useMemberStats(userId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.member.stats(userId ?? ''),
    queryFn: ({ signal }) => api.get<MemberStats>('/members/' + userId + '/stats', signal),
    enabled: Boolean(userId),
  });
}

/**
 * A person's last twenty actions, for their own page.
 *
 * Read from the activity table rather than assembled from their tasks, so it
 * shows what they did rather than what happens to be assigned to them now.
 */
export function useMemberActivity(userId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.member.activity(userId ?? ''),
    queryFn: ({ signal }) =>
      api.get<{ items: MemberActivityEntry[] }>(
        '/members/' + userId + '/activity?limit=20',
        signal,
      ),
    enabled: Boolean(userId),
  });
}
