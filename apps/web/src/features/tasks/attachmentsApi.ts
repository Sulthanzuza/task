import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserSummary } from '@tm/shared';
import { api, getAccessToken, refreshSession, toQuery } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/** Files on a task: listing them, adding one with a progress bar, removing one. */

export interface Attachment {
  id: string;
  taskId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: { id: string; name: string; avatarUrl: string | null };
  downloadUrl: string;
  createdAt: string;
}

export function useAttachments(taskIdOrKey: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tasks.attachments(taskIdOrKey ?? ''),
    queryFn: ({ signal }) =>
      api.get<{ items: Attachment[] }>('/tasks/' + taskIdOrKey + '/attachments', signal),
    enabled: Boolean(taskIdOrKey),
  });
}

/**
 * Uploading, with a progress bar.
 *
 * XMLHttpRequest rather than fetch, only because fetch cannot report how much
 * of a request body has gone. A big attachment on a slow line otherwise looks
 * like a page that has frozen.
 */
async function uploadWithProgress(
  path: string,
  file: File,
  onProgress: (fraction: number) => void,
  isRetry = false,
): Promise<Attachment> {
  const token = getAccessToken();

  const attempt = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/v1' + path);
    request.withCredentials = true;
    request.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    if (token) request.setRequestHeader('Authorization', 'Bearer ' + token);

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });

    request.addEventListener('load', () =>
      resolve({ status: request.status, body: request.responseText }),
    );
    request.addEventListener('error', () =>
      reject(new Error('The upload did not reach the server.')),
    );
    request.addEventListener('abort', () => reject(new Error('The upload was cancelled.')));

    const form = new FormData();
    form.append('file', file);
    request.send(form);
  });

  // The same one-retry-after-refresh rule the rest of the client follows.
  if (attempt.status === 401 && !isRetry && (await refreshSession())) {
    return uploadWithProgress(path, file, onProgress, true);
  }

  if (attempt.status >= 400) {
    throw new Error(messageFrom(attempt.body, attempt.status));
  }

  return JSON.parse(attempt.body) as Attachment;
}

/** The server's own words where it gave any, so "too large" says so. */
function messageFrom(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // A proxy error page is not JSON; fall through to the status.
  }
  if (status === 413) return 'That file is larger than the limit.';
  if (status === 415) return 'That kind of file cannot be attached.';
  return 'The upload failed (' + status + ').';
}

export function useUploadAttachment(taskIdOrKey: string | undefined) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ file, onProgress }: { file: File; onProgress: (fraction: number) => void }) =>
      uploadWithProgress('/tasks/' + taskIdOrKey + '/attachments', file, onProgress),

    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.tasks.attachments(taskIdOrKey ?? '') }),
        // The upload writes an activity row, so the timeline has changed too.
        client.invalidateQueries({ queryKey: queryKeys.tasks.timeline(taskIdOrKey ?? '') }),
      ]);
    },
  });
}

export function useDeleteAttachment(taskIdOrKey: string | undefined) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (attachmentId: string) => api.delete<void>('/attachments/' + attachmentId),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.tasks.attachments(taskIdOrKey ?? '') }),
        client.invalidateQueries({ queryKey: queryKeys.tasks.timeline(taskIdOrKey ?? '') }),
      ]);
    },
  });
}

/**
 * Who may be mentioned here.
 *
 * Asked of the server rather than worked out from the team list, because only
 * the server knows who can actually read this task.
 */
export function useMentionableUsers(taskIdOrKey: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.tasks.mentionable(taskIdOrKey ?? ''),
    queryFn: ({ signal }) =>
      api.get<{ items: UserSummary[] }>(
        '/tasks/' + taskIdOrKey + '/mentionable' + toQuery({}),
        signal,
      ),
    enabled: enabled && Boolean(taskIdOrKey),
    staleTime: 60_000,
  });
}
