import { useQuery } from '@tanstack/react-query';
import type {
  AttentionItem,
  DashboardSummary,
  MemberRow,
  MemberStats,
} from '@tm/shared';
import { api, toQuery } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useDashboardSummary(teamId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboard.summary(teamId),
    queryFn: ({ signal }) => api.get<DashboardSummary>('/dashboard/summary' + toQuery({ teamId }), signal),
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
      api.get<{ items: AttentionItem[] }>('/dashboard/attention' + toQuery({ teamId, limit: 10 }), signal),
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
