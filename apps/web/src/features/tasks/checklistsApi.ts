import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChecklistDraft, ChecklistsResponse } from '@tm/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Checklists on a task.
 *
 * Every mutation invalidates the task as well as the lists, because ticking
 * an item can move the task's progress, and the detail page shows both.
 */

export function useChecklists(taskIdOrKey: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tasks.checklists(taskIdOrKey ?? ''),
    queryFn: ({ signal }) =>
      api.get<ChecklistsResponse>('/tasks/' + taskIdOrKey + '/checklists', signal),
    enabled: Boolean(taskIdOrKey),
  });
}

/** Everything a checklist change touches. */
function useChecklistInvalidation(taskIdOrKey: string | undefined) {
  const client = useQueryClient();

  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.tasks.checklists(taskIdOrKey ?? '') }),
      // Progress may have moved with the tick.
      client.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskIdOrKey ?? '') }),
      client.invalidateQueries({ queryKey: queryKeys.tasks.timeline(taskIdOrKey ?? '') }),
      // And the badge on every card in a list the task appears in.
      client.invalidateQueries({ queryKey: queryKeys.tasks.all }),
    ]);
  };
}

export function useAddChecklist(taskIdOrKey: string | undefined) {
  const invalidate = useChecklistInvalidation(taskIdOrKey);

  return useMutation({
    mutationFn: (draft: ChecklistDraft) =>
      api.post<{ id: string }>('/tasks/' + taskIdOrKey + '/checklists', draft),
    onSuccess: invalidate,
  });
}

export function useRenameChecklist(taskIdOrKey: string | undefined) {
  const invalidate = useChecklistInvalidation(taskIdOrKey);

  return useMutation({
    mutationFn: ({ checklistId, title }: { checklistId: string; title: string }) =>
      api.patch<void>('/checklists/' + checklistId, { title }),
    onSuccess: invalidate,
  });
}

export function useDeleteChecklist(taskIdOrKey: string | undefined) {
  const invalidate = useChecklistInvalidation(taskIdOrKey);

  return useMutation({
    mutationFn: (checklistId: string) => api.delete<void>('/checklists/' + checklistId),
    onSuccess: invalidate,
  });
}

export function useAddChecklistItem(taskIdOrKey: string | undefined) {
  const invalidate = useChecklistInvalidation(taskIdOrKey);

  return useMutation({
    mutationFn: ({ checklistId, text }: { checklistId: string; text: string }) =>
      api.post<{ id: string }>('/checklists/' + checklistId + '/items', { text }),
    onSuccess: invalidate,
  });
}

export function useUpdateChecklistItem(taskIdOrKey: string | undefined) {
  const invalidate = useChecklistInvalidation(taskIdOrKey);

  return useMutation({
    mutationFn: ({ itemId, ...change }: { itemId: string; text?: string; isDone?: boolean }) =>
      api.patch<void>('/checklist-items/' + itemId, change),
    onSuccess: invalidate,
  });
}

export function useDeleteChecklistItem(taskIdOrKey: string | undefined) {
  const invalidate = useChecklistInvalidation(taskIdOrKey);

  return useMutation({
    mutationFn: (itemId: string) => api.delete<void>('/checklist-items/' + itemId),
    onSuccess: invalidate,
  });
}

export function useReorderChecklists(taskIdOrKey: string | undefined) {
  const invalidate = useChecklistInvalidation(taskIdOrKey);

  return useMutation({
    mutationFn: (ids: string[]) =>
      api.patch<void>('/tasks/' + taskIdOrKey + '/checklists/order', { ids }),
    onSuccess: invalidate,
  });
}

export function useReorderChecklistItems(taskIdOrKey: string | undefined) {
  const invalidate = useChecklistInvalidation(taskIdOrKey);

  return useMutation({
    mutationFn: ({ checklistId, ids }: { checklistId: string; ids: string[] }) =>
      api.patch<void>('/checklists/' + checklistId + '/items/order', { ids }),
    onSuccess: invalidate,
  });
}

/** Whether progress is counted from the ticks or set by hand. */
export function useProgressSource(taskIdOrKey: string | undefined) {
  const invalidate = useChecklistInvalidation(taskIdOrKey);

  return useMutation({
    mutationFn: (enabled: boolean) =>
      api.patch<void>('/tasks/' + taskIdOrKey + '/checklists/progress-source', { enabled }),
    onSuccess: invalidate,
  });
}
