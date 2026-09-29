import { EventEmitter } from 'node:events';
import type { TaskStatus } from '@tm/shared';
import { logger } from './logger';

/**
 * In-process domain events, emitted after a transaction commits.
 * Notifications, realtime and integrations subscribe here rather than reaching into
 * the task service, so the task module stays unaware of them.
 */

export interface TaskEventBase {
  taskId: string;
  taskKey: string;
  projectId: string;
  /** Which team may see this, so the gateway can pick the room without a query. */
  teamId: string;
  title: string;
  actorId: string | null;
  at: Date;
  /** The task's updated_at after the change; lets a client drop stale events. */
  updatedAt: Date;
  /** Echoed so the originating tab can ignore its own change. */
  clientMutationId: string | null;
}

export interface DomainEvents {
  'task.created': TaskEventBase & { assigneeId: string | null; reviewerId: string | null };
  'task.updated': TaskEventBase & { changedFields: string[] };
  'task.transitioned': TaskEventBase & {
    from: TaskStatus;
    to: TaskStatus;
    assigneeId: string | null;
    reviewerId: string | null;
    watcherIds: string[];
  };
  'task.assigned': TaskEventBase & {
    assigneeId: string | null;
    previousAssigneeId: string | null;
    reviewerId: string | null;
    handoverNote: string | null;
  };
  'task.progress': TaskEventBase & { from: number; to: number };
  'task.deleted': TaskEventBase;
  'comment.created': TaskEventBase & {
    commentId: string;
    body: string;
    mentionedUserIds: string[];
    watcherIds: string[];
  };
  'attachment.created': TaskEventBase & { attachmentId: string; fileName: string };
  'dependency.completed': TaskEventBase & { dependentTaskIds: string[] };
}

export type DomainEventName = keyof DomainEvents;

class TypedEmitter {
  private readonly emitter = new EventEmitter({ captureRejections: true });

  constructor() {
    this.emitter.setMaxListeners(50);
    this.emitter.on('error', (error: unknown) => {
      logger.error({ err: error }, 'A domain event listener threw.');
    });
  }

  on<K extends DomainEventName>(name: K, listener: (payload: DomainEvents[K]) => void): void {
    this.emitter.on(name, (payload) => {
      try {
        const result = listener(payload as DomainEvents[K]) as unknown;
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            logger.error({ err: error, event: name }, 'A domain event listener rejected.');
          });
        }
      } catch (error) {
        // A broken listener must never fail the request that emitted the event.
        logger.error({ err: error, event: name }, 'A domain event listener threw.');
      }
    });
  }

  emit<K extends DomainEventName>(name: K, payload: DomainEvents[K]): void {
    this.emitter.emit(name, payload);
  }

  removeAll(): void {
    this.emitter.removeAllListeners();
  }
}

export const events = new TypedEmitter();

/**
 * Events must only reach listeners once the data they describe is durable.
 * Collect them during a transaction and flush after it commits.
 */
export class EventBuffer {
  private readonly queued: Array<() => void> = [];

  add<K extends DomainEventName>(name: K, payload: DomainEvents[K]): void {
    this.queued.push(() => events.emit(name, payload));
  }

  flush(): void {
    for (const emit of this.queued) emit();
    this.queued.length = 0;
  }
}
