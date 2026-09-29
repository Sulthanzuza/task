import { z } from 'zod';
import { taskStatusSchema } from './enums';
import { uuidSchema } from './schemas/common';

/**
 * The realtime contract, shared so the server cannot broadcast something the
 * client does not expect.
 */

/** Header carrying the id a tab stamps on its own mutations. */
export const CLIENT_MUTATION_ID_HEADER = 'x-client-mutation-id';

export const SOCKET_EVENTS = {
  taskChanged: 'task:changed',
  taskDeleted: 'task:deleted',
  notificationNew: 'notification:new',
  /** Sent to every tab of one user, so a read in one clears the bell in all. */
  notificationRead: 'notification:read',
  /** The server tells a client its session is gone before closing the socket. */
  sessionRevoked: 'session:revoked',
} as const;

/**
 * Every task event carries three things that make it safe to apply out of order
 * or twice:
 *
 * - updatedAt, so a client can drop an event older than what it already holds;
 * - actorId and clientMutationId, so the tab that caused the change can ignore
 *   its own echo, having already applied it optimistically.
 */
export const taskChangedEventSchema = z.object({
  taskId: uuidSchema,
  taskKey: z.string(),
  projectId: uuidSchema,
  teamId: uuidSchema,
  /**
   * The new status, when the event knows it (a transition does; a comment does
   * not). Null means "something changed, go and look" rather than a guess.
   */
  status: taskStatusSchema.nullable(),
  assigneeId: uuidSchema.nullable(),
  reviewerId: uuidSchema.nullable(),
  /** The task's updated_at after the change, as an ISO string. */
  updatedAt: z.string(),
  actorId: uuidSchema.nullable(),
  clientMutationId: z.string().nullable(),
  /** What happened, for logging and for deciding which caches to touch. */
  reason: z.enum([
    'created',
    'updated',
    'transitioned',
    'assigned',
    'progress',
    'commented',
    'attached',
  ]),
});
export type TaskChangedEvent = z.infer<typeof taskChangedEventSchema>;

export const taskDeletedEventSchema = z.object({
  taskId: uuidSchema,
  projectId: uuidSchema,
  teamId: uuidSchema,
  actorId: uuidSchema.nullable(),
  clientMutationId: z.string().nullable(),
  updatedAt: z.string(),
});
export type TaskDeletedEvent = z.infer<typeof taskDeletedEventSchema>;

/** Room names are built by the server from what the user may see, never sent by the client. */
export const rooms = {
  user: (userId: string) => 'user:' + userId,
  project: (projectId: string) => 'project:' + projectId,
  team: (teamId: string) => 'team:' + teamId,
} as const;

export const SOCKET_ERROR_CODES = {
  unauthenticated: 'UNAUTHENTICATED',
  forbidden: 'FORBIDDEN',
} as const;

/** True when a connect_error means "your token is no good", rather than a network problem. */
export function isAuthSocketError(message: string | undefined): boolean {
  if (!message) return false;
  return (
    message.includes(SOCKET_ERROR_CODES.unauthenticated) ||
    message.includes(SOCKET_ERROR_CODES.forbidden)
  );
}

export const notificationEventSchema = z.object({
  notificationId: uuidSchema,
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  taskKey: z.string().nullable(),
  createdAt: z.string(),
  unread: z.number().int(),
});
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

export const notificationReadEventSchema = z.object({
  /** Null means every notification was marked read at once. */
  notificationId: uuidSchema.nullable(),
  unread: z.number().int(),
});
export type NotificationReadEvent = z.infer<typeof notificationReadEventSchema>;
