import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import type {
  AssignTaskInput,
  BoardSummary,
  CommentEntry,
  CreateTaskInput,
  Label,
  ListTasksQuery,
  TaskDetail,
  TaskSummary,
  TimelineEntry,
  TransitionTaskInput,
  UpdateTaskInput,
  UserSummary,
} from '@tm/shared';
import { parseMentions } from '@tm/shared';
import { api, toQuery } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/** All task data access goes through these hooks; components never call fetch. */

interface TaskPage {
  items: TaskSummary[];
  nextCursor: string | null;
}

export function useTaskList(filters: Partial<ListTasksQuery>) {
  return useInfiniteQuery({
    queryKey: queryKeys.tasks.list(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get<TaskPage>('/tasks' + toQuery({ ...filters, cursor: pageParam }), signal),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useTask(idOrKey: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tasks.detail(idOrKey ?? ''),
    queryFn: ({ signal }) => api.get<TaskDetail>('/tasks/' + idOrKey, signal),
    enabled: Boolean(idOrKey),
  });
}

export function useTaskTimeline(idOrKey: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tasks.timeline(idOrKey ?? ''),
    queryFn: ({ signal }) =>
      api.get<{ items: TimelineEntry[] }>('/tasks/' + idOrKey + '/timeline', signal),
    enabled: Boolean(idOrKey),
  });
}

/**
 * After any task change: refresh this task, its timeline, every list, and the
 * dashboard, because a status change moves the KPI counts too.
 */
function useTaskInvalidation() {
  const client = useQueryClient();
  return (task?: TaskDetail) => {
    void client.invalidateQueries({ queryKey: queryKeys.tasks.all });
    void client.invalidateQueries({ queryKey: queryKeys.dashboard.all });
    if (task) {
      client.setQueryData(queryKeys.tasks.detail(task.id), task);
      client.setQueryData(queryKeys.tasks.detail(task.key), task);
    }
  };
}

/**
 * Optimistic task edits.
 *
 * A task is cached under both its id and its key, so a change has to be
 * written to both or the same task looks different depending on which link
 * you followed. What was there before is kept so a refusal puts it back
 * exactly, rather than leaving the screen showing a change that never
 * happened.
 */
interface OptimisticContext {
  entries: Array<[readonly unknown[], TaskDetail | undefined]>;
}

function useOptimisticTask(taskIdOrKey: string | undefined) {
  const client = useQueryClient();

  return {
    async apply(change: (task: TaskDetail) => TaskDetail): Promise<OptimisticContext> {
      const current = client.getQueryData<TaskDetail>(queryKeys.tasks.detail(taskIdOrKey ?? ''));
      const keys = current
        ? [queryKeys.tasks.detail(current.id), queryKeys.tasks.detail(current.key)]
        : [queryKeys.tasks.detail(taskIdOrKey ?? '')];

      const entries: OptimisticContext['entries'] = [];

      for (const key of keys) {
        // An in-flight refetch would otherwise land on top of the guess.
        await client.cancelQueries({ queryKey: key });
        const previous = client.getQueryData<TaskDetail>(key);
        entries.push([key, previous]);
        if (previous) client.setQueryData<TaskDetail>(key, change(previous));
      }

      return { entries };
    },

    rollback(context: OptimisticContext | undefined) {
      for (const [key, previous] of context?.entries ?? []) {
        client.setQueryData(key, previous);
      }
    },
  };
}

export function useCreateTask(
  projectId: string | undefined,
): UseMutationResult<TaskDetail, Error, CreateTaskInput> {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (input: CreateTaskInput) =>
      api.post<TaskDetail>('/projects/' + projectId + '/tasks', input),
    onSuccess: (task) => invalidate(task),
  });
}

export function useUpdateTask(taskId: string | undefined) {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (input: UpdateTaskInput) => api.patch<TaskDetail>('/tasks/' + taskId, input),
    onSuccess: (task) => invalidate(task),
  });
}

/**
 * The new status shows at once and goes back if the server refuses it.
 *
 * The button was only offered because the shared workflow table allows the
 * move, so the guess is nearly always right; when it is not, the refusal is
 * shown and the old status returns rather than the screen quietly disagreeing
 * with the server.
 */
export function useTransitionTask(taskId: string | undefined) {
  const invalidate = useTaskInvalidation();
  const optimistic = useOptimisticTask(taskId);

  return useMutation({
    mutationFn: (input: TransitionTaskInput) =>
      api.post<TaskDetail>('/tasks/' + taskId + '/transition', input),

    onMutate: (input: TransitionTaskInput) =>
      optimistic.apply((task) => ({
        ...task,
        status: input.to,
        blockedReason: input.to === 'BLOCKED' ? (input.blockedReason ?? null) : null,
        blockerType: input.to === 'BLOCKED' ? (input.blockerType ?? null) : null,
        // The next set of buttons is the server's to decide; showing the old
        // ones against the new status would offer moves that do not exist.
        availableTransitions: [],
      })),

    onError: (_error, _input, context) => optimistic.rollback(context),
    onSuccess: (task) => invalidate(task),
  });
}

export function useAssignTask(taskId: string | undefined, people: UserSummary[] = []) {
  const invalidate = useTaskInvalidation();
  const optimistic = useOptimisticTask(taskId);

  return useMutation({
    mutationFn: (input: AssignTaskInput) =>
      api.post<TaskDetail>('/tasks/' + taskId + '/assign', input),

    onMutate: (input: AssignTaskInput) =>
      optimistic.apply((task) => ({
        ...task,
        assignee:
          input.assigneeId === null || input.assigneeId === undefined
            ? null
            : (people.find((person) => person.id === input.assigneeId) ?? task.assignee),
      })),

    onError: (_error, _input, context) => optimistic.rollback(context),
    onSuccess: (task) => invalidate(task),
  });
}

/**
 * Labels, changed from the chips on the task itself.
 *
 * Separate from useUpdateTask because it is the one field edited by clicking
 * rather than by filling in a form, so it wants the same immediacy as a drag.
 */
export function useSetLabels(taskId: string | undefined, known: Label[] = []) {
  const invalidate = useTaskInvalidation();
  const optimistic = useOptimisticTask(taskId);

  return useMutation({
    mutationFn: (labelIds: string[]) =>
      api.patch<TaskDetail>('/tasks/' + taskId, { labelIds } satisfies UpdateTaskInput),

    onMutate: (labelIds: string[]) =>
      optimistic.apply((task) => ({
        ...task,
        labels: labelIds
          .map(
            (id) => known.find((label) => label.id === id) ?? task.labels.find((l) => l.id === id),
          )
          .filter((label): label is Label => label !== undefined),
      })),

    onError: (_error, _labelIds, context) => optimistic.rollback(context),
    onSuccess: (task) => invalidate(task),
  });
}

/**
 * Progress is dragged, so it updates optimistically and rolls back if the server
 * disagrees. Everything else waits for the server, because a status is not a guess.
 */
export function useUpdateProgress(taskId: string | undefined) {
  const client = useQueryClient();
  const invalidate = useTaskInvalidation();

  return useMutation({
    mutationFn: (progress: number) =>
      api.put<TaskDetail>('/tasks/' + taskId + '/progress', { progress }),

    onMutate: async (progress: number) => {
      const key = queryKeys.tasks.detail(taskId ?? '');
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<TaskDetail>(key);
      if (previous) client.setQueryData<TaskDetail>(key, { ...previous, progress });
      return { previous, key };
    },

    onError: (_error, _progress, context) => {
      if (context?.previous) client.setQueryData(context.key, context.previous);
    },

    onSuccess: (task) => invalidate(task),
  });
}

export function useDeleteTask() {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (taskId: string) => api.delete<void>('/tasks/' + taskId),
    onSuccess: () => invalidate(),
  });
}

/** Comments that have not reached the server yet are drawn differently. */
export const PENDING_COMMENT_PREFIX = 'pending:';

export function isPendingComment(id: string): boolean {
  return id.startsWith(PENDING_COMMENT_PREFIX);
}

/**
 * A comment appears the moment it is sent.
 *
 * Typing is the one place where a round trip is felt most, so the comment is
 * shown at once, marked as sending, and removed again if it does not go
 * through. The provisional id is a local one; the real row replaces it when
 * the timeline refetches.
 */
export function useAddComment(taskIdOrKey: string | undefined, author: UserSummary | null) {
  const client = useQueryClient();
  const key = queryKeys.tasks.timeline(taskIdOrKey ?? '');

  return useMutation({
    mutationFn: (body: string) =>
      api.post<CommentEntry>('/tasks/' + taskIdOrKey + '/comments', { body }),

    onMutate: async (body: string) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<{ items: TimelineEntry[] }>(key);

      if (previous && author) {
        const pending: CommentEntry = {
          kind: 'comment',
          id: PENDING_COMMENT_PREFIX + Date.now().toString(36),
          author,
          body,
          mentionedUserIds: parseMentions(body).map((mention) => mention.userId),
          editedAt: null,
          createdAt: new Date().toISOString(),
          // Not yet a real row, so it cannot be edited or deleted.
          canEdit: false,
          canDelete: false,
        };
        client.setQueryData(key, { items: [...previous.items, pending] });
      }

      return { previous };
    },

    onError: (_error, _body, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },

    onSettled: () => {
      void client.invalidateQueries({ queryKey: key });
      void client.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskIdOrKey ?? '') });
    },
  });
}

export function useDeleteComment(taskIdOrKey: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => api.delete<void>('/comments/' + commentId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.tasks.timeline(taskIdOrKey ?? '') });
    },
  });
}

export function useWatchToggle(taskId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (watching: boolean) =>
      watching
        ? api.delete<void>('/tasks/' + taskId + '/watchers/me')
        : api.post<void>('/tasks/' + taskId + '/watchers/me'),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId ?? '') });
    },
  });
}

/** Column counts, counted on the server so they match the dashboard. */
export function useBoardSummary(filters: { projectId?: string | undefined }) {
  return useQuery({
    queryKey: ['tasks', 'board', filters],
    queryFn: ({ signal }) => api.get<BoardSummary>('/tasks/board' + toQuery(filters), signal),
  });
}
