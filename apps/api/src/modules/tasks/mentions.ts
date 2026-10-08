import { and, asc, eq, inArray, ilike, ne, or, sql } from 'drizzle-orm';
import type { UserSummary } from '@tm/shared';
import { db } from '../../db/client';
import { teamMembers, teams, users } from '../../db/schema';
import type { Actor } from '../../middleware/authenticate';
import { can, authorize } from '../permissions/authorize';
import { associatedIdList, MATCHES_NOBODY } from './associated';
import { loadTaskOr404, toResource } from './service';

/**
 * Who may be mentioned on a task.
 *
 * Narrower than who may read it: the people the task is about, as
 * associatedUserIds defines them. Offering the whole team meant a mention was
 * the easiest way to pull somebody into a thread they had no context for,
 * which is how a notification list stops being read.
 *
 * Everyone returned is somebody a mention would actually reach, because the
 * same set decides what the server records. The browser never guesses.
 */
export async function mentionableUsers(
  actor: Actor,
  idOrKey: string,
  query?: string,
): Promise<UserSummary[]> {
  const task = await loadTaskOr404(db, idOrKey);
  const resource = await toResource(db, task);

  // You must be able to see the task yourself before you can ask who else can.
  authorize(actor, 'task.view', resource);

  const associated = await associatedIdList(db, { ...resource, id: task.id });

  const filters = [
    eq(users.isActive, true),
    // Mentioning yourself notifies nobody, so it is not offered.
    ne(users.id, actor.id),
    associated.length > 0 ? inArray(users.id, associated) : MATCHES_NOBODY,
  ];

  if (query && query.trim() !== '') {
    const like = '%' + query.trim() + '%';
    filters.push(or(ilike(users.name, like), ilike(users.email, like))!);
  }

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      avatarUrl: users.avatarUrl,
      isActive: users.isActive,
      teamIds: sql<string[]>`COALESCE(
        ARRAY(SELECT tm.team_id FROM ${teamMembers} tm WHERE tm.user_id = ${users.id}),
        '{}'
      )`,
      // A lead need not be a member of the team they lead, so both are needed
      // to ask the permission rules an honest question about them.
      ledTeamIds: sql<string[]>`COALESCE(
        ARRAY(SELECT t.id FROM ${teams} t WHERE t.lead_id = ${users.id}),
        '{}'
      )`,
    })
    .from(users)
    .where(and(...filters))
    .orderBy(asc(users.name))
    // A picker is not a directory; a longer list means a better search term.
    .limit(50);

  return rows
    .filter((row) =>
      can(
        { id: row.id, role: row.role, teamIds: row.teamIds, ledTeamIds: row.ledTeamIds },
        'task.view',
        resource,
      ),
    )
    .map(({ teamIds: _teamIds, ledTeamIds: _ledTeamIds, ...summary }) => summary);
}
