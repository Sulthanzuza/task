import { eq, sql } from 'drizzle-orm';
import { tasks, teams } from '../../db/schema';
import type { Db } from '../../db/client';
import type { TaskResource } from '../permissions/authorize';

/**
 * The people a task is actually about.
 *
 * Mentions used to offer anybody on the team, which on a team of twenty meant
 * typing "@ra" and being shown four people with no connection to the work.
 * Worse, it made a mention the easiest way to pull somebody into a thread
 * they had no context for, which is how a notification list stops being read.
 *
 * So the set is explicit: whoever created it, whoever is doing it, whoever is
 * reviewing it, whoever has chosen to follow it, and the lead of the team
 * that owns the project, who is accountable for it whether or not they are
 * named on it. A group child adds the parent's creator, because the person
 * who split the work up is the one to ask about it.
 *
 * Anybody else has to be added as a watcher first. That is one extra step,
 * and it leaves an activity row saying who brought them in.
 */
export async function associatedUserIds(
  handle: Db,
  resource: TaskResource & { id: string },
): Promise<Set<string>> {
  const ids = new Set<string>();

  const add = (id: string | null | undefined) => {
    if (id) ids.add(id);
  };

  add(resource.createdBy);
  add(resource.assigneeId);
  add(resource.reviewerId);
  resource.watcherIds.forEach(add);

  /*
   * The lead of the owning team, read from the team rather than from the
   * actor: a lead who is not a member of the team they lead is still its
   * lead, and is still answerable for the task.
   */
  const [team] = await handle
    .select({ leadId: teams.leadId })
    .from(teams)
    .where(eq(teams.id, resource.teamId))
    .limit(1);
  add(team?.leadId ?? null);

  /*
   * A group child is one person's share of a larger piece of work. Whoever
   * created the parent decided on that split, so they belong in the
   * conversation about any of the pieces.
   */
  if (resource.parentTaskId) {
    const [parent] = await handle
      .select({ createdBy: tasks.createdBy, isGroup: tasks.isGroup })
      .from(tasks)
      .where(eq(tasks.id, resource.parentTaskId))
      .limit(1);

    if (parent?.isGroup) add(parent.createdBy);
  }

  return ids;
}

/**
 * The same set, as SQL, for filtering a user query without a second round
 * trip. Returns the ids so the caller can use them in an IN clause.
 */
export async function associatedIdList(
  handle: Db,
  resource: TaskResource & { id: string },
): Promise<string[]> {
  return [...(await associatedUserIds(handle, resource))];
}

/** A no-match clause, for when the set is empty. */
export const MATCHES_NOBODY = sql`false`;
