import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateLabelInput, Label } from '@tm/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Creating a label without leaving the form.
 *
 * A label belongs to a project when one is known, so the same word can mean
 * different things on different projects; without a project it is a global
 * label available everywhere.
 */
export function useCreateLabel(projectId?: string) {
  const client = useQueryClient();

  /** A readable default, spread around the hues so two new labels differ. */
  const colour = () => {
    const palette = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
    return palette[Math.floor(Math.random() * palette.length)] as string;
  };

  return useMutation({
    mutationFn: (name: string) =>
      api.post<Label>('/labels', {
        name,
        color: colour(),
        ...(projectId ? { projectId } : {}),
      } satisfies CreateLabelInput),

    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.projects.labels(projectId) });
    },
  });
}
