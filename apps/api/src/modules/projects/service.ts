import { and, asc, eq, ilike, inArray, isNull, or, isNotNull } from 'drizzle-orm';
import type {
  CreateLabelInput,
  CreateProjectInput,
  Label,
  ListProjectsQuery,
  Project,
  UpdateProjectInput,
} from '@tm/shared';
import { db } from '../../db/client';
import { labels, projects } from '../../db/schema';
import type { Actor } from '../../middleware/authenticate';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors';
import { authorize } from '../permissions/authorize';

function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status,
    teamId: row.teamId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

export async function listProjects(actor: Actor, query: ListProjectsQuery): Promise<{ items: Project[] }> {
  const filters = [];

  if (actor.role !== 'SUPER_ADMIN') {
    const scope = [...new Set([...actor.teamIds, ...actor.ledTeamIds])];
    if (scope.length === 0) return { items: [] };
    filters.push(inArray(projects.teamId, scope));
  }

  if (query.teamId) filters.push(eq(projects.teamId, query.teamId));
  if (query.q) filters.push(or(ilike(projects.name, '%' + query.q + '%'), ilike(projects.key, '%' + query.q + '%'))!);

  // Archived projects are hidden unless they are asked for.
  if (query.archived === true) filters.push(isNotNull(projects.archivedAt));
  else if (query.archived !== undefined) filters.push(isNull(projects.archivedAt));
  else filters.push(isNull(projects.archivedAt));

  const rows = await db
    .select()
    .from(projects)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(projects.key));

  return { items: rows.map(toProject) };
}

export async function getProject(actor: Actor, projectId: string): Promise<Project> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!row) throw new NotFoundError('That project');

  authorize(actor, 'project.view', { kind: 'project', teamId: row.teamId });
  return toProject(row);
}

export async function createProject(actor: Actor, input: CreateProjectInput): Promise<Project> {
  authorize(actor, 'project.create', { kind: 'project', teamId: input.teamId });

  const existing = await db.select({ id: projects.id }).from(projects).where(eq(projects.key, input.key)).limit(1);
  if (existing.length > 0) throw new ConflictError('A project already uses the key ' + input.key + '.');

  const [created] = await db
    .insert(projects)
    .values({
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      teamId: input.teamId,
      status: input.status,
      createdBy: actor.id,
    })
    .returning();

  if (!created) throw new Error('Project insert returned no row');
  return toProject(created);
}

export async function updateProject(
  actor: Actor,
  projectId: string,
  input: UpdateProjectInput,
): Promise<Project> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!row) throw new NotFoundError('That project');

  authorize(actor, 'project.update', { kind: 'project', teamId: row.teamId });

  // Moving a project to another team is a super admin decision, not a lead's.
  if (input.teamId && input.teamId !== row.teamId) {
    authorize(actor, 'team.manage', { kind: 'team', teamId: input.teamId });
  }

  const changes: Record<string, unknown> = {};
  if (input.name !== undefined) changes.name = input.name;
  if (input.description !== undefined) changes.description = input.description;
  if (input.status !== undefined) changes.status = input.status;
  if (input.teamId !== undefined) changes.teamId = input.teamId;

  const [updated] = await db.update(projects).set(changes).where(eq(projects.id, projectId)).returning();
  if (!updated) throw new NotFoundError('That project');
  return toProject(updated);
}

export async function archiveProject(actor: Actor, projectId: string, now = new Date()): Promise<Project> {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!row) throw new NotFoundError('That project');

  authorize(actor, 'project.archive', { kind: 'project', teamId: row.teamId });

  const [updated] = await db
    .update(projects)
    .set({ archivedAt: row.archivedAt ? null : now })
    .where(eq(projects.id, projectId))
    .returning();

  if (!updated) throw new NotFoundError('That project');
  return toProject(updated);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export async function listLabels(actor: Actor, projectId?: string): Promise<{ items: Label[] }> {
  if (projectId) await getProject(actor, projectId);

  const rows = await db
    .select()
    .from(labels)
    .where(projectId ? or(eq(labels.projectId, projectId), isNull(labels.projectId)) : isNull(labels.projectId))
    .orderBy(asc(labels.name));

  return {
    items: rows.map((r) => ({ id: r.id, projectId: r.projectId, name: r.name, color: r.color })),
  };
}

export async function createLabel(actor: Actor, input: CreateLabelInput): Promise<Label> {
  if (input.projectId) {
    const project = await getProject(actor, input.projectId);
    authorize(actor, 'project.update', { kind: 'project', teamId: project.teamId });
  } else {
    // Labels shared by every project are an organisation-wide decision.
    authorize(actor, 'org.manage', { kind: 'org' });
  }

  const [created] = await db
    .insert(labels)
    .values({ name: input.name, color: input.color, projectId: input.projectId ?? null })
    .onConflictDoNothing()
    .returning();

  if (!created) throw new ConflictError('A label with that name already exists here.');
  return { id: created.id, projectId: created.projectId, name: created.name, color: created.color };
}

export { ValidationError };
