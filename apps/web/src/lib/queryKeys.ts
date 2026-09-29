import type { ListTasksQuery } from '@tm/shared';

/**
 * Every cache key in one place, so an invalidation after a mutation cannot miss
 * a list that happens to be open on another screen.
 */
export const queryKeys = {
  me: ['me'] as const,

  tasks: {
    all: ['tasks'] as const,
    list: (filters: Partial<ListTasksQuery>) => ['tasks', 'list', filters] as const,
    detail: (idOrKey: string) => ['tasks', 'detail', idOrKey] as const,
    timeline: (idOrKey: string) => ['tasks', 'timeline', idOrKey] as const,
    attachments: (idOrKey: string) => ['tasks', 'attachments', idOrKey] as const,
    mentionable: (idOrKey: string) => ['tasks', 'mentionable', idOrKey] as const,
  },

  projects: {
    all: ['projects'] as const,
    list: () => ['projects', 'list'] as const,
    detail: (id: string) => ['projects', 'detail', id] as const,
    labels: (projectId?: string) => ['projects', 'labels', projectId ?? 'global'] as const,
  },

  users: {
    all: ['users'] as const,
    list: (filters: Record<string, unknown>) => ['users', 'list', filters] as const,
    detail: (id: string) => ['users', 'detail', id] as const,
  },

  teams: {
    all: ['teams'] as const,
    list: () => ['teams', 'list'] as const,
  },

  dashboard: {
    all: ['dashboard'] as const,
    summary: (teamId?: string) => ['dashboard', 'summary', teamId ?? 'mine'] as const,
    members: (teamId?: string) => ['dashboard', 'members', teamId ?? 'mine'] as const,
    attention: (teamId?: string) => ['dashboard', 'attention', teamId ?? 'mine'] as const,
  },

  member: {
    stats: (userId: string) => ['member', 'stats', userId] as const,
    activity: (userId: string) => ['member', 'activity', userId] as const,
  },

  admin: {
    all: ['admin'] as const,
    settings: () => ['admin', 'settings'] as const,
    /** The prefix, for invalidating every year at once after a change. */
    holidaysAll: ['admin', 'holidays'] as const,
    holidays: (year?: number) => ['admin', 'holidays', year ?? 'all'] as const,
    audit: (filters: Record<string, unknown> = {}) => ['admin', 'audit', filters] as const,
    digestPreview: (userId?: string, date?: string) =>
      ['admin', 'digest-preview', userId ?? 'me', date ?? 'today'] as const,
    importColumns: () => ['admin', 'import-columns'] as const,
  },
} as const;
