import { useQuery } from '@tanstack/react-query';
import type { Label, Project, TeamDetail, UserSummary } from '@tm/shared';
import { api, toQuery } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects.list(),
    queryFn: ({ signal }) => api.get<{ items: Project[] }>('/projects', signal),
    staleTime: 60_000,
  });
}

export function useTeams() {
  return useQuery({
    queryKey: queryKeys.teams.list(),
    queryFn: ({ signal }) => api.get<{ items: TeamDetail[] }>('/teams', signal),
    staleTime: 60_000,
  });
}

export function useUsers(filters: { teamId?: string; q?: string } = {}) {
  return useQuery({
    queryKey: queryKeys.users.list(filters),
    queryFn: ({ signal }) =>
      api.get<{ items: UserSummary[]; nextCursor: string | null }>(
        '/users' + toQuery({ ...filters, limit: 100 }),
        signal,
      ),
    staleTime: 60_000,
  });
}

export function useLabels(projectId?: string) {
  return useQuery({
    queryKey: queryKeys.projects.labels(projectId),
    queryFn: ({ signal }) => api.get<{ items: Label[] }>('/labels' + toQuery({ projectId }), signal),
    staleTime: 60_000,
  });
}
