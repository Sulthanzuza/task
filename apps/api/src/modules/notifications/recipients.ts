import { eq, inArray } from 'drizzle-orm';
import type { NotificationType } from '@tm/shared';
import type { Db } from '../../db/client';
import { teamMembers, teams, users } from '../../db/schema';
import type { Actor } from '../../middleware/authenticate';
import { can, type TaskResource } from '../permissions/authorize';

/**
 * Who gets told, and who must not be.
 *
 * Every candidate is checked with the same permission rule the HTTP routes use,
 * because a notification carries a task title and key. Mentioning someone who
 * cannot see a task must tell them nothing at all, rather than leaking the title
 * through a message they were never meant to receive.
 */

export interface Candidate {
  userId: string;
  type: NotificationType;
}

export interface ResolvedRecipient {
  userId: string;
  type: NotificationType;
  timezone: string;
  email: string;
  name: string;
}

/** Everything needed to decide, loaded once for the whole set of candidates. */
interface RecipientRow {
  id: string;
  name: string;
  email: string;
  timezone: string;
  isActive: boolean;
  role: Actor['role'];
  teamIds: string[];
  ledTeamIds: string[];
}

async function loadCandidates(handle: Db, userIds: string[]): Promise<Map<string, RecipientRow>> {
  const unique = [...new Set(userIds)].filter(Boolean);
  const byId = new Map<string, RecipientRow>();
  if (unique.length === 0) return byId;

  const rows = await handle
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      timezone: users.timezone,
      isActive: users.isActive,
      role: users.role,
    })
    .from(users)
    .where(inArray(users.id, unique));

  const memberships = await handle
    .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(inArray(teamMembers.userId, unique));

  const led = await handle
    .select({ leadId: teams.leadId, teamId: teams.id })
    .from(teams)
    .where(inArray(teams.leadId, unique));

  for (const row of rows) {
    const teamIds = memberships.filter((m) => m.userId === row.id).map((m) => m.teamId);
    const ledTeamIds = led.filter((l) => l.leadId === row.id).map((l) => l.teamId);
    byId.set(row.id, {
      ...row,
      ledTeamIds,
      teamIds: [...new Set([...teamIds, ...ledTeamIds])],
    });
  }

  return byId;
}

export interface ResolveInput {
  handle: Db;
  task: TaskResource;
  /** Whoever caused the change. They never hear about their own action. */
  actorId: string | null;
  candidates: Candidate[];
}

/**
 * Narrow a list of candidates down to the people who should actually be told.
 *
 * Dropped: the actor, deactivated accounts, anyone who cannot see the task, and
 * duplicates. Where one person qualifies twice, the more specific reason wins:
 * being mentioned is more informative than being a watcher.
 */
export async function resolveRecipients(input: ResolveInput): Promise<ResolvedRecipient[]> {
  const { handle, task, actorId, candidates } = input;
  if (candidates.length === 0) return [];

  const people = await loadCandidates(
    handle,
    candidates.map((c) => c.userId),
  );

  const chosen = new Map<string, ResolvedRecipient>();

  for (const candidate of candidates) {
    // Nobody needs telling about something they just did.
    if (candidate.userId === actorId) continue;
    if (chosen.has(candidate.userId)) continue;

    const person = people.get(candidate.userId);
    if (!person || !person.isActive) continue;

    const recipient: Actor = {
      id: person.id,
      role: person.role,
      teamIds: person.teamIds,
      ledTeamIds: person.ledTeamIds,
    };

    // The decisive check: a notification is a disclosure.
    if (!can(recipient, 'task.view', task)) continue;

    chosen.set(person.id, {
      userId: person.id,
      type: candidate.type,
      timezone: person.timezone,
      email: person.email,
      name: person.name,
    });
  }

  return [...chosen.values()];
}

/** The watchers of a task, as notification candidates. */
export async function watcherCandidates(
  handle: Db,
  taskId: string,
  type: NotificationType,
): Promise<Candidate[]> {
  const { taskWatchers } = await import('../../db/schema');
  const rows = await handle
    .select({ userId: taskWatchers.userId })
    .from(taskWatchers)
    .where(eq(taskWatchers.taskId, taskId));
  return rows.map((row) => ({ userId: row.userId, type }));
}
