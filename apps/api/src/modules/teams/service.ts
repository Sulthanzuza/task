import { and, asc, eq } from 'drizzle-orm';
import type { CreateTeamInput, TeamDetail, UpdateTeamInput } from '@tm/shared';
import { db, withTransaction } from '../../db/client';
import { teamMembers, teams, users } from '../../db/schema';
import type { Actor } from '../../middleware/authenticate';
import { NotFoundError } from '../../lib/errors';
import { authorize } from '../permissions/authorize';
import { usersByIdList } from '../users/service';

export async function listTeams(actor: Actor): Promise<TeamDetail[]> {
  const rows = await db.select().from(teams).orderBy(asc(teams.name));

  // A member only sees the teams they are part of.
  const visible =
    actor.role === 'SUPER_ADMIN'
      ? rows
      : rows.filter((t) => actor.teamIds.includes(t.id) || actor.ledTeamIds.includes(t.id));

  return Promise.all(visible.map((row) => buildTeamDetail(row.id)));
}

export async function getTeam(actor: Actor, teamId: string): Promise<TeamDetail> {
  if (actor.role !== 'SUPER_ADMIN' && !actor.teamIds.includes(teamId) && !actor.ledTeamIds.includes(teamId)) {
    authorize(actor, 'team.manage', { kind: 'team', teamId });
  }
  return buildTeamDetail(teamId);
}

async function buildTeamDetail(teamId: string): Promise<TeamDetail> {
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (!team) throw new NotFoundError('That team');

  const memberRows = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));

  const members = await usersByIdList(memberRows.map((m) => m.userId));
  const lead = team.leadId ? (await usersByIdList([team.leadId]))[0] ?? null : null;

  return {
    id: team.id,
    name: team.name,
    leadId: team.leadId,
    createdAt: team.createdAt.toISOString(),
    lead,
    members,
  };
}

export async function createTeam(actor: Actor, input: CreateTeamInput): Promise<TeamDetail> {
  authorize(actor, 'team.manage', { kind: 'team', teamId: 'new' });

  const teamId = await withTransaction(async (tx) => {
    const [created] = await tx
      .insert(teams)
      .values({ name: input.name, leadId: input.leadId ?? null })
      .returning({ id: teams.id });

    if (!created) throw new Error('Team insert returned no row');

    // A lead is always a member of the team they lead.
    if (input.leadId) {
      await tx
        .insert(teamMembers)
        .values({ teamId: created.id, userId: input.leadId })
        .onConflictDoNothing();
    }
    return created.id;
  });

  return buildTeamDetail(teamId);
}

export async function updateTeam(
  actor: Actor,
  teamId: string,
  input: UpdateTeamInput,
): Promise<TeamDetail> {
  authorize(actor, 'team.manage', { kind: 'team', teamId });

  await withTransaction(async (tx) => {
    const changes: Record<string, unknown> = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.leadId !== undefined) changes.leadId = input.leadId;

    if (Object.keys(changes).length > 0) {
      const updated = await tx.update(teams).set(changes).where(eq(teams.id, teamId)).returning({ id: teams.id });
      if (updated.length === 0) throw new NotFoundError('That team');
    }

    if (input.leadId) {
      await tx.insert(teamMembers).values({ teamId, userId: input.leadId }).onConflictDoNothing();
    }
  });

  return buildTeamDetail(teamId);
}

export async function addMember(actor: Actor, teamId: string, userId: string): Promise<TeamDetail> {
  authorize(actor, 'team.manage', { kind: 'team', teamId });

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('That user');

  await db.insert(teamMembers).values({ teamId, userId }).onConflictDoNothing();
  return buildTeamDetail(teamId);
}

export async function removeMember(actor: Actor, teamId: string, userId: string): Promise<TeamDetail> {
  authorize(actor, 'team.manage', { kind: 'team', teamId });

  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));

  return buildTeamDetail(teamId);
}
