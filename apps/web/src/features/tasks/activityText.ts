import type { ActivityAction, TaskStatus, TimelineEntry } from '@tm/shared';
import { STATUS_LABELS } from '@tm/shared';

/**
 * Every activity row, as a sentence somebody would say.
 *
 * The timeline used to end in a `default` that printed the action name, so a
 * new kind of event arrived on screen as "Sulthan attachment.created". That
 * is a database column leaking into the product, and nothing failed when it
 * happened.
 *
 * So the switch is exhaustive over ActivityAction with no default: adding an
 * action to the shared list stops the build until it has words, and the unit
 * test walks the whole list in case the type is ever widened again.
 */

type Activity = Extract<TimelineEntry, { kind: 'activity' }>;

/** The attachment's own name, which both attachment events carry. */
function fileNameOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const name = (value as { fileName?: unknown }).fileName;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

function statusLabel(value: unknown): string {
  return typeof value === 'string' && value in STATUS_LABELS
    ? STATUS_LABELS[value as TaskStatus]
    : 'somewhere else';
}

export function describeActivity(entry: Activity): string {
  const who = entry.actor?.name ?? 'The system';
  const action: ActivityAction = entry.action;

  switch (action) {
    case 'task.created':
      return who + ' created this task';
    case 'task.imported':
      return who + ' imported this task';
    case 'task.updated':
      return who + ' changed ' + (entry.field ?? 'a field');
    case 'task.transitioned':
      return (
        who + ' moved it from ' + statusLabel(entry.oldValue) + ' to ' + statusLabel(entry.newValue)
      );
    case 'task.assigned':
      return entry.newValue ? who + ' changed the assignee' : who + ' removed the assignee';
    case 'task.reviewer_changed':
      return entry.newValue ? who + ' changed the reviewer' : who + ' removed the reviewer';
    case 'task.progress':
      return (
        who +
        ' moved progress from ' +
        String(entry.oldValue) +
        '% to ' +
        String(entry.newValue) +
        '%'
      );
    case 'task.deleted':
      return who + ' deleted this task';
    case 'task.restored':
      return who + ' restored this task';
    case 'task.label_added':
      return who + ' added a label';
    case 'task.label_removed':
      return who + ' removed a label';
    case 'task.dependency_added':
      return who + ' made it wait on another task';
    case 'task.dependency_removed':
      return who + ' removed a dependency';
    case 'task.watcher_added':
      return who + ' started watching';
    case 'task.watcher_removed':
      return who + ' stopped watching';
    case 'comment.created':
      // The comment itself is rendered; a line saying one exists would double it.
      return '';
    case 'comment.edited':
      return who + ' edited a comment';
    case 'comment.deleted':
      return who + ' deleted a comment';
    case 'attachment.created': {
      const name = fileNameOf(entry.newValue);
      return name ? who + ' attached ' + name : who + ' attached a file';
    }
    case 'attachment.deleted': {
      const name = fileNameOf(entry.oldValue) ?? fileNameOf(entry.newValue);
      return name ? who + ' removed ' + name : who + ' removed a file';
    }
  }
}
