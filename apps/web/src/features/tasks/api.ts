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
  ListTasksQuery,
  TaskDetail,
  TaskSummary,
  TimelineEntry,
  TransitionTaskInput,
  UpdateTaskInput,
} from '@tm/shared';
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

export function useTransitionTask(taskId: string | undefined) {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (input: TransitionTaskInput) =>
      api.post<TaskDetail>('/tasks/' + taskId + '/transition', input),
    onSuccess: (task) => invalidate(task),
  });
}

export function useAssignTask(taskId: string | undefined) {
  const invalidate = useTaskInvalidation();
  return useMutation({
    mutationFn: (input: AssignTaskInput) => api.post<TaskDetail>('/tasks/' + taskId + '/assign', input),
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

export function useAddComment(taskIdOrKey: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api.post<CommentEntry>('/tasks/' + taskIdOrKey + '/comments', { body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.tasks.timeline(taskIdOrKey ?? '') });
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
