import type { NotificationView } from './api';

/**
 * Several updates to one task, as one line.
 *
 * A task being commented on, reassigned and moved in the same hour produced
 * four rows that all said the same key, and they pushed everything else off
 * the list. Unread notifications for one task collapse into a single row
 * that can be opened; read ones are left alone, because the pile a person
 * has already dealt with is history and reordering it helps nobody.
 */

export interface NotificationGroup {
  /** The group's own identity, for a React key and for expansion state. */
  id: string;
  taskKey: string | null;
  /** Newest first, as they arrived. */
  items: NotificationView[];
  /** The newest one, which supplies the title and the link. */
  latest: NotificationView;
  unread: number;
}

/** One line's worth of words: "4 updates from Rahul", or the body if it is alone. */
export function summarise(group: NotificationGroup): string {
  if (group.items.length === 1) {
    return group.latest.body ?? '';
  }

  const names = Array.from(
    new Set(group.items.map((item) => item.actorName).filter((name): name is string => !!name)),
  );

  const who =
    names.length === 0
      ? ''
      : names.length === 1
        ? ' from ' + names[0]
        : names.length === 2
          ? ' from ' + names[0] + ' and ' + names[1]
          : ' from ' + names[0] + ' and ' + (names.length - 1) + ' others';

  return group.items.length + ' updates' + who;
}

export function groupNotifications(items: NotificationView[]): NotificationGroup[] {
  const groups: NotificationGroup[] = [];
  const byTask = new Map<string, NotificationGroup>();

  for (const item of items) {
    const unread = item.readAt === null;

    /*
     * Only unread items for a real task are worth collapsing. Grouping read
     * ones would quietly rewrite a list somebody has already been through,
     * and a notification with no task has nothing to group on.
     */
    if (!unread || !item.taskId) {
      groups.push({
        id: item.id,
        taskKey: item.taskKey,
        items: [item],
        latest: item,
        unread: unread ? 1 : 0,
      });
      continue;
    }

    const existing = byTask.get(item.taskId);
    if (existing) {
      existing.items.push(item);
      existing.unread += 1;
      continue;
    }

    const group: NotificationGroup = {
      id: 'task:' + item.taskId,
      taskKey: item.taskKey,
      items: [item],
      latest: item,
      unread: 1,
    };
    byTask.set(item.taskId, group);
    groups.push(group);
  }

  return groups;
}
