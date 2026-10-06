import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AuditEntryView,
  CreateHolidayInput,
  CreateProjectInput,
  CreateTeamInput,
  CreateUserInput,
  InvitedUser,
  IssuedLink,
  ResentInvite,
  Holiday,
  ListAuditQuery,
  OrgSettingsView,
  Project,
  TeamDetail,
  UpdateOrgSettingsInput,
  UpdateProjectInput,
  UpdateTeamInput,
  UpdateUserInput,
  UserDetail,
  UserSummary,
} from '@tm/shared';
import { api, apiRequest, toQuery } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The admin area's data access.
 *
 * Every call here goes to a route that already existed; this file is the
 * plumbing between those routes and the screens, and the one place that knows
 * which caches a change invalidates.
 */

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface PeopleFilters {
  q?: string;
  role?: UserSummary['role'];
  active?: boolean;
  teamId?: string;
}

export function useAdminPeople(filters: PeopleFilters) {
  return useQuery({
    queryKey: queryKeys.users.list({ admin: true, ...filters }),
    queryFn: ({ signal }) =>
      api.get<{ items: UserSummary[]; nextCursor: string | null }>(
        '/users' + toQuery({ ...filters, limit: 100 }),
        signal,
      ),
  });
}

export function useUserDetail(userId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.users.detail(userId ?? ''),
    queryFn: ({ signal }) => api.get<UserDetail>('/users/' + userId, signal),
    enabled: Boolean(userId),
  });
}

/** Everything that changes a person invalidates the same three caches. */
function usePeopleInvalidation() {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.users.all }),
      client.invalidateQueries({ queryKey: queryKeys.teams.all }),
      client.invalidateQueries({ queryKey: queryKeys.admin.audit() }),
    ]);
  };
}

export function useInviteUser() {
  const refresh = usePeopleInvalidation();
  return useMutation({
    mutationFn: (input: CreateUserInput) => api.post<InvitedUser>('/users', input),
    onSuccess: refresh,
  });
}

export function useUpdateUser() {
  const refresh = usePeopleInvalidation();
  return useMutation({
    mutationFn: ({ userId, ...input }: UpdateUserInput & { userId: string }) =>
      api.patch<UserDetail>('/users/' + userId, input),
    onSuccess: refresh,
  });
}

export function useSetUserActive() {
  const refresh = usePeopleInvalidation();
  return useMutation({
    mutationFn: ({ userId, active }: { userId: string; active: boolean }) =>
      api.post<void>('/users/' + userId + (active ? '/activate' : '/deactivate')),
    onSuccess: refresh,
  });
}

export function useResendInvite() {
  const refresh = usePeopleInvalidation();
  return useMutation({
    mutationFn: (userId: string) => api.post<ResentInvite>('/users/' + userId + '/resend-invite'),
    onSuccess: refresh,
  });
}

/** A one-time reset link for an admin to hand over; nothing is emailed. */
export function useIssueResetLink() {
  const refresh = usePeopleInvalidation();
  return useMutation({
    mutationFn: (userId: string) => api.post<IssuedLink>('/users/' + userId + '/reset-link'),
    onSuccess: refresh,
  });
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export function useAdminTeams() {
  return useQuery({
    queryKey: queryKeys.teams.list(),
    queryFn: ({ signal }) => api.get<{ items: TeamDetail[] }>('/teams', signal),
  });
}

function useTeamInvalidation() {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.teams.all }),
      client.invalidateQueries({ queryKey: queryKeys.users.all }),
      client.invalidateQueries({ queryKey: queryKeys.admin.audit() }),
    ]);
  };
}

export function useCreateTeam() {
  const refresh = useTeamInvalidation();
  return useMutation({
    mutationFn: (input: CreateTeamInput) => api.post<TeamDetail>('/teams', input),
    onSuccess: refresh,
  });
}

export function useUpdateTeam() {
  const refresh = useTeamInvalidation();
  return useMutation({
    mutationFn: ({ teamId, ...input }: UpdateTeamInput & { teamId: string }) =>
      api.patch<TeamDetail>('/teams/' + teamId, input),
    onSuccess: refresh,
  });
}

export function useAddTeamMember() {
  const refresh = useTeamInvalidation();
  return useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      api.post<TeamDetail>('/teams/' + teamId + '/members', { userId }),
    onSuccess: refresh,
  });
}

export function useRemoveTeamMember() {
  const refresh = useTeamInvalidation();
  return useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      api.delete<TeamDetail>('/teams/' + teamId + '/members/' + userId),
    onSuccess: refresh,
  });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function useAdminProjects(includeArchived: boolean) {
  return useQuery({
    queryKey: [...queryKeys.projects.list(), { archived: includeArchived }] as const,
    queryFn: ({ signal }) =>
      api.get<{ items: Project[]; nextCursor: string | null }>(
        '/projects' + toQuery({ archived: includeArchived ? undefined : false, limit: 100 }),
        signal,
      ),
  });
}

function useProjectInvalidation() {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.projects.all }),
      client.invalidateQueries({ queryKey: queryKeys.admin.audit() }),
    ]);
  };
}

export function useCreateProject() {
  const refresh = useProjectInvalidation();
  return useMutation({
    mutationFn: (input: CreateProjectInput) => api.post<Project>('/projects', input),
    onSuccess: refresh,
  });
}

export function useUpdateProject() {
  const refresh = useProjectInvalidation();
  return useMutation({
    mutationFn: ({ projectId, ...input }: UpdateProjectInput & { projectId: string }) =>
      api.patch<Project>('/projects/' + projectId, input),
    onSuccess: refresh,
  });
}

/** The same route restores an archived project, which is why it is a toggle. */
export function useArchiveProject() {
  const refresh = useProjectInvalidation();
  return useMutation({
    mutationFn: (projectId: string) => api.post<Project>('/projects/' + projectId + '/archive'),
    onSuccess: refresh,
  });
}

// ---------------------------------------------------------------------------
// Organisation settings
// ---------------------------------------------------------------------------

export function useOrgSettings() {
  return useQuery({
    queryKey: queryKeys.admin.settings(),
    queryFn: ({ signal }) => api.get<OrgSettingsView>('/org/settings', signal),
  });
}

export function useUpdateOrgSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrgSettingsInput) =>
      api.patch<OrgSettingsView>('/org/settings', input),
    onSuccess: async (settings) => {
      client.setQueryData(queryKeys.admin.settings(), settings);
      // Thresholds and the time zone change what counts as overdue, so every
      // list and figure on screen is now out of date.
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.tasks.all }),
        client.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
        client.invalidateQueries({ queryKey: queryKeys.admin.audit() }),
      ]);
    },
  });
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export function useHolidays(year?: number) {
  return useQuery({
    queryKey: queryKeys.admin.holidays(year),
    queryFn: ({ signal }) =>
      api.get<{ items: Holiday[] }>('/org/holidays' + toQuery({ year }), signal),
  });
}

interface HolidayChange {
  added: number;
  alreadyThere: number;
  items: Holiday[];
}

function useHolidayInvalidation() {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.admin.holidaysAll }),
      // Working days moved, so anything dated is suspect.
      client.invalidateQueries({ queryKey: queryKeys.tasks.all }),
      client.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
      client.invalidateQueries({ queryKey: queryKeys.admin.audit() }),
    ]);
  };
}

export function useAddHoliday() {
  const refresh = useHolidayInvalidation();
  return useMutation({
    mutationFn: (input: CreateHolidayInput) => api.post<HolidayChange>('/org/holidays', input),
    onSuccess: refresh,
  });
}

export function useAddHolidaysBulk() {
  const refresh = useHolidayInvalidation();
  return useMutation({
    mutationFn: (items: CreateHolidayInput[]) =>
      api.post<HolidayChange>('/org/holidays/bulk', { items }),
    onSuccess: refresh,
  });
}

export function useRemoveHoliday() {
  const refresh = useHolidayInvalidation();
  return useMutation({
    mutationFn: (date: string) => api.delete<void>('/org/holidays/' + date),
    onSuccess: refresh,
  });
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export function useSendTestEmail() {
  return useMutation({
    mutationFn: () => api.post<{ sent: boolean; to: string }>('/org/test-email'),
  });
}

export interface DigestPreview {
  kind: 'lead' | 'member';
  date: string;
  userId: string;
  counts: Record<string, number>;
  [key: string]: unknown;
}

export function useDigestPreview(params: { userId?: string; date?: string }, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.admin.digestPreview(params.userId, params.date),
    queryFn: ({ signal }) =>
      api.get<DigestPreview>('/org/digest-preview' + toQuery({ ...params }), signal),
    enabled,
  });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function useAudit(filters: ListAuditQuery) {
  return useQuery({
    queryKey: queryKeys.admin.audit(filters),
    queryFn: ({ signal }) =>
      api.get<{ items: AuditEntryView[]; actions: string[] }>(
        '/org/audit' + toQuery({ ...filters, limit: filters.limit ?? 200 }),
        signal,
      ),
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportRowProblem {
  rowNumber: number;
  column: string;
  message: string;
}

export interface ImportPreviewRow {
  rowNumber: number;
  title: string;
  projectKey: string;
  assigneeEmail: string | null;
  priority: string;
  status: string;
  dueDate: string | null;
  estimateHours: number | null;
}

export interface ImportPreviewResult {
  ready: ImportPreviewRow[];
  problems: ImportRowProblem[];
  totalRows: number;
}

export interface ImportCommitResult extends ImportPreviewResult {
  created: Array<{ rowNumber: number; taskKey: string }>;
}

/**
 * The file is sent, not a parsed copy of it.
 *
 * Committing re-reads and re-validates the upload server side, so the preview
 * the operator saw is advice rather than authorisation. That means the same
 * file has to be posted twice, which is why both calls take the File itself.
 */
function postFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return apiRequest<T>(path, { method: 'POST', body: form });
}

export function useImportPreview() {
  return useMutation({
    mutationFn: (file: File) => postFile<ImportPreviewResult>('/import/preview', file),
  });
}

export function useImportCommit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => postFile<ImportCommitResult>('/import/commit', file),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.tasks.all }),
        client.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
      ]);
    },
  });
}

export function useImportColumns() {
  return useQuery({
    queryKey: queryKeys.admin.importColumns(),
    queryFn: ({ signal }) => api.get<{ columns: string[] }>('/import/columns', signal),
    staleTime: Infinity,
  });
}
