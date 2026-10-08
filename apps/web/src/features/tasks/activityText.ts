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

/** Why the file was attached, kept on the event so it outlives the file. */
function descriptionOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const text = (value as { description?: unknown }).description;
  return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
}

/** Trimmed text, or null when there is nothing worth printing. */
function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** A value in single quotes, or a plain stand-in when there is nothing to quote. */
function quoted(value: unknown, fallback: string): string {
  const text = asText(value);
  return text ? '‘' + text + '’' : fallback;
}

/** " in Testing", when the activity row recorded which list it was. */
function inList(entry: Activity): string {
  const meta = entry.meta as { checklistTitle?: unknown } | null | undefined;
  const title = asText(meta?.checklistTitle);
  return title ? ' in ' + title : '';
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
    case 'checklist.added':
      return who + ' added the checklist ' + quoted(entry.newValue, 'a checklist');
    case 'checklist.renamed':
      return (
        who +
        ' renamed ' +
        quoted(entry.oldValue, 'a checklist') +
        ' to ' +
        quoted(entry.newValue, 'something else')
      );
    case 'checklist.deleted':
      return who + ' deleted the checklist ' + quoted(entry.oldValue, 'a checklist');
    case 'checklist.item_ticked':
      // "Rahul ticked 'API tests' in Testing" — the step and the list it is in,
      // because the step's wording alone often means nothing out of context.
      return who + ' ticked ' + quoted(entry.newValue, 'a step') + inList(entry);
    case 'checklist.item_unticked':
      return who + ' unticked ' + quoted(entry.newValue, 'a step') + inList(entry);
    case 'comment.created':
      // The comment itself is rendered; a line saying one exists would double it.
      return '';
    case 'comment.edited':
      return who + ' edited a comment';
    case 'comment.deleted':
      return who + ' deleted a comment';
    case 'attachment.created': {
      const name = fileNameOf(entry.newValue);
      if (!name) return who + ' attached a file';
      const why = descriptionOf(entry.newValue);
      return why ? who + ' attached ' + name + ': ' + why : who + ' attached ' + name;
    }
    case 'attachment.deleted': {
      const name = fileNameOf(entry.oldValue) ?? fileNameOf(entry.newValue);
      return name ? who + ' removed ' + name : who + ' removed a file';
    }
  }
}
