import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { BlockerType, TaskPriority, TaskStatus } from '@tm/shared';
import { closeDatabase, db } from './client';
import {
  holidays,
  labels,
  orgSettings,
  projects,
  taskActivity,
  taskComments,
  taskLabels,
  taskWatchers,
  tasks,
  teamMembers,
  teams,
  users,
} from './schema';
import { env } from '../config/env';
import { hashPassword } from '../lib/crypto';
import { logger } from '../lib/logger';
import { addDays, toDateOnly } from '../lib/date-utils';

/**
 * Idempotent seed: running it twice leaves the same data, so it is safe to re-run
 * against a database that is already populated.
 */

const NOW = new Date();
const TZ = env.SEED_TIMEZONE;
const TODAY = toDateOnly(NOW, TZ);

function daysFromToday(offset: number): string {
  return addDays(TODAY, offset);
}

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

async function seedOrgSettings(): Promise<void> {
  await db
    .insert(orgSettings)
    .values({
      id: 1,
      timezone: TZ,
      weekendDays: [0, 6],
      weekStartsOn: 1,
      workHoursPerDay: '8',
      noUpdateThresholdHours: 24,
      digestTime: '09:00:00',
    })
    .onConflictDoUpdate({
      target: orgSettings.id,
      set: { timezone: TZ, updatedAt: NOW },
    });

  // A couple of holidays so the working-day maths has something to skip.
  const year = TODAY.slice(0, 4);
  await db
    .insert(holidays)
    .values([
      { date: year + '-10-02', name: 'Gandhi Jayanti' },
      { date: year + '-12-25', name: 'Christmas Day' },
    ])
    .onConflictDoNothing();
}

interface SeedUser {
  name: string;
  email: string;
  role: 'SUPER_ADMIN' | 'TEAM_LEAD' | 'MEMBER';
}

const SEED_USERS: SeedUser[] = [
  { name: 'Admin', email: 'admin@example.com', role: 'SUPER_ADMIN' },
  { name: 'Sulthan', email: 'sulthan@example.com', role: 'TEAM_LEAD' },
  { name: 'Rahul', email: 'rahul@example.com', role: 'MEMBER' },
  { name: 'Arun', email: 'arun@example.com', role: 'MEMBER' },
  { name: 'Faisal', email: 'faisal@example.com', role: 'MEMBER' },
  { name: 'Akhil', email: 'akhil@example.com', role: 'MEMBER' },
  // Leads the second team. Nothing of theirs is visible to the first team,
  // which is what makes cross-team access testable.
  { name: 'Nisha', email: 'nisha@example.com', role: 'TEAM_LEAD' },
];

async function seedUsers(): Promise<Map<string, string>> {
  const passwordHash = await hashPassword(env.SEED_PASSWORD);
  const ids = new Map<string, string>();

  for (const user of SEED_USERS) {
    const [row] = await db
      .insert(users)
      .values({ ...user, passwordHash, timezone: TZ })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: user.name, role: user.role, passwordHash, isActive: true },
      })
      .returning({ id: users.id });

    if (row) ids.set(user.email, row.id);
  }

  return ids;
}

async function seedTeam(userIds: Map<string, string>): Promise<string> {
  const leadId = userIds.get('sulthan@example.com');

  const existing = await db.select().from(teams).where(eq(teams.name, 'Product Engineering')).limit(1);
  let teamId = existing[0]?.id;

  if (!teamId) {
    const [created] = await db
      .insert(teams)
      .values({ name: 'Product Engineering', leadId: leadId ?? null })
      .returning({ id: teams.id });
    teamId = created?.id;
  } else {
    await db.update(teams).set({ leadId: leadId ?? null }).where(eq(teams.id, teamId));
  }

  if (!teamId) throw new Error('Could not create the team');

  const memberEmails = [
    'sulthan@example.com',
    'rahul@example.com',
    'arun@example.com',
    'faisal@example.com',
    'akhil@example.com',
  ];

  await db
    .insert(teamMembers)
    .values(
      memberEmails
        .map((email) => userIds.get(email))
        .filter((id): id is string => Boolean(id))
        .map((userId) => ({ teamId: teamId as string, userId })),
    )
    .onConflictDoNothing();

  return teamId;
}

/**
 * A second team, with its own lead, project and task.
 * Nobody from the first team belongs to it, so any route that leaks its data
 * across the team boundary shows up immediately in the tests.
 */
async function seedSecondTeam(
  userIds: Map<string, string>,
  createdBy: string,
): Promise<{ teamId: string; projectId: string }> {
  const leadId = userIds.get('nisha@example.com');
  if (!leadId) throw new Error('The second team lead must exist');

  const existing = await db.select().from(teams).where(eq(teams.name, 'Platform')).limit(1);
  let teamId = existing[0]?.id;

  if (!teamId) {
    const [created] = await db
      .insert(teams)
      .values({ name: 'Platform', leadId })
      .returning({ id: teams.id });
    teamId = created?.id;
  }
  if (!teamId) throw new Error('Could not create the Platform team');

  await db.insert(teamMembers).values({ teamId, userId: leadId }).onConflictDoNothing();

  const [project] = await db
    .insert(projects)
    .values({
      key: 'OPS',
      name: 'Platform Operations',
      description: 'Infrastructure work for the platform team.',
      teamId,
      createdBy,
    })
    .onConflictDoUpdate({ target: projects.key, set: { name: 'Platform Operations' } })
    .returning({ id: projects.id });

  if (!project) throw new Error('Could not create the OPS project');

  const alreadyThere = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.projectId, project.id))
    .limit(1);

  if (alreadyThere.length === 0) {
    const [counter] = await db
      .update(projects)
      .set({ taskCounter: sql`${projects.taskCounter} + 1` })
      .where(eq(projects.id, project.id))
      .returning({ number: projects.taskCounter });

    if (counter) {
      const [task] = await db
        .insert(tasks)
        .values({
          projectId: project.id,
          number: counter.number,
          title: 'Rotate the production database credentials',
          description: 'Platform team work. Not visible to the product team.',
          status: 'IN_PROGRESS',
          priority: 'HIGH',
          createdBy: leadId,
          assigneeId: leadId,
          progress: 40,
          dueDate: daysFromToday(3),
          estimatedMinutes: 240,
          lastActivityAt: hoursAgo(4),
          createdAt: hoursAgo(72),
          updatedAt: hoursAgo(4),
        })
        .returning({ id: tasks.id });

      if (task) {
        await db.insert(taskWatchers).values({ taskId: task.id, userId: leadId }).onConflictDoNothing();
        await db.insert(taskActivity).values({
          taskId: task.id,
          actorId: leadId,
          action: 'task.created',
          newValue: { title: 'Rotate the production database credentials', status: 'BACKLOG' },
          createdAt: hoursAgo(72),
        });
      }
    }
  }

  return { teamId, projectId: project.id };
}

async function seedProjects(teamId: string, createdBy: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const project of [
    { key: 'ERP', name: 'ERP Platform', description: 'Core ERP modules and integrations.' },
    { key: 'CRM', name: 'CRM Revamp', description: 'Customer portal and pipeline tooling.' },
  ]) {
    const [row] = await db
      .insert(projects)
      .values({ ...project, teamId, createdBy })
      .onConflictDoUpdate({ target: projects.key, set: { name: project.name } })
      .returning({ id: projects.id });

    if (row) ids.set(project.key, row.id);
  }

  return ids;
}

async function seedLabels(projectIds: Map<string, string>): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const erp = projectIds.get('ERP');

  for (const label of [
    { name: 'bug', color: '#dc2626', projectId: null },
    { name: 'feature', color: '#2563eb', projectId: null },
    { name: 'tech-debt', color: '#7c3aed', projectId: null },
    { name: 'invoicing', color: '#059669', projectId: erp ?? null },
  ]) {
    const [row] = await db.insert(labels).values(label).onConflictDoNothing().returning({ id: labels.id });

    if (row) {
      ids.set(label.name, row.id);
    } else {
      const [existing] = await db.select({ id: labels.id }).from(labels).where(eq(labels.name, label.name)).limit(1);
      if (existing) ids.set(label.name, existing.id);
    }
  }

  return ids;
}

interface SeedTask {
  project: 'ERP' | 'CRM';
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  reviewer: string | null;
  progress: number;
  dueOffset: number | null;
  estimatedHours: number | null;
  lastActivityHoursAgo: number;
  blockedReason?: string;
  blockerType?: BlockerType;
  blockedHoursAgo?: number;
  completedDaysAgo?: number;
  labels?: string[];
}

const RAHUL = 'rahul@example.com';
const ARUN = 'arun@example.com';
const FAISAL = 'faisal@example.com';
const AKHIL = 'akhil@example.com';
const SULTHAN = 'sulthan@example.com';

/** Spread across every status, with overdue, due-today, blocked and in-review examples. */
const SEED_TASKS: SeedTask[] = [
  { project: 'ERP', title: 'Fix invoice rounding on multi-currency orders', status: 'IN_PROGRESS', priority: 'URGENT', assignee: RAHUL, reviewer: SULTHAN, progress: 45, dueOffset: -3, estimatedHours: 8, lastActivityHoursAgo: 2, labels: ['bug', 'invoicing'] },
  { project: 'ERP', title: 'Add UAE VAT breakdown to the invoice PDF', status: 'IN_PROGRESS', priority: 'HIGH', assignee: RAHUL, reviewer: SULTHAN, progress: 20, dueOffset: 0, estimatedHours: 6, lastActivityHoursAgo: 40, labels: ['feature', 'invoicing'] },
  { project: 'ERP', title: 'Stock ledger reconciliation job', status: 'BLOCKED', priority: 'HIGH', assignee: ARUN, reviewer: SULTHAN, progress: 30, dueOffset: -1, estimatedHours: 12, lastActivityHoursAgo: 30, blockedReason: 'Waiting on the warehouse team to confirm the opening balances', blockerType: 'WAITING_ON_PERSON', blockedHoursAgo: 30 },
  { project: 'ERP', title: 'Purchase order approval workflow', status: 'READY_FOR_REVIEW', priority: 'MEDIUM', assignee: ARUN, reviewer: SULTHAN, progress: 95, dueOffset: 2, estimatedHours: 16, lastActivityHoursAgo: 26 },
  { project: 'ERP', title: 'Migrate reports to the new query layer', status: 'IN_REVIEW', priority: 'MEDIUM', assignee: FAISAL, reviewer: RAHUL, progress: 90, dueOffset: 1, estimatedHours: 20, lastActivityHoursAgo: 5, labels: ['tech-debt'] },
  { project: 'ERP', title: 'Credit note cancellation leaves orphan rows', status: 'CHANGES_REQUESTED', priority: 'HIGH', assignee: FAISAL, reviewer: SULTHAN, progress: 70, dueOffset: -2, estimatedHours: 5, lastActivityHoursAgo: 8, labels: ['bug'] },
  { project: 'ERP', title: 'Bulk import for supplier master data', status: 'ASSIGNED', priority: 'LOW', assignee: AKHIL, reviewer: null, progress: 0, dueOffset: 5, estimatedHours: 10, lastActivityHoursAgo: 12 },
  { project: 'ERP', title: 'Retire the legacy tax table', status: 'BACKLOG', priority: 'LOW', assignee: null, reviewer: null, progress: 0, dueOffset: null, estimatedHours: null, lastActivityHoursAgo: 72, labels: ['tech-debt'] },
  { project: 'ERP', title: 'Warehouse barcode scanning screen', status: 'COMPLETED', priority: 'MEDIUM', assignee: RAHUL, reviewer: SULTHAN, progress: 100, dueOffset: -4, estimatedHours: 14, lastActivityHoursAgo: 48, completedDaysAgo: 2 },
  { project: 'ERP', title: 'Duplicate GRN entries under load', status: 'COMPLETED', priority: 'URGENT', assignee: ARUN, reviewer: SULTHAN, progress: 100, dueOffset: -6, estimatedHours: 6, lastActivityHoursAgo: 96, completedDaysAgo: 4, labels: ['bug'] },
  { project: 'ERP', title: 'Drop the unused pricing experiment', status: 'CANCELLED', priority: 'LOW', assignee: AKHIL, reviewer: null, progress: 10, dueOffset: -8, estimatedHours: 3, lastActivityHoursAgo: 120 },

  { project: 'CRM', title: 'Customer portal single sign-on', status: 'IN_PROGRESS', priority: 'HIGH', assignee: AKHIL, reviewer: SULTHAN, progress: 55, dueOffset: 0, estimatedHours: 18, lastActivityHoursAgo: 1, labels: ['feature'] },
  { project: 'CRM', title: 'Pipeline stage drag and drop is slow', status: 'IN_PROGRESS', priority: 'MEDIUM', assignee: FAISAL, reviewer: ARUN, progress: 35, dueOffset: 3, estimatedHours: 8, lastActivityHoursAgo: 50, labels: ['bug'] },
  { project: 'CRM', title: 'Lead deduplication rules', status: 'BLOCKED', priority: 'MEDIUM', assignee: RAHUL, reviewer: null, progress: 15, dueOffset: 4, estimatedHours: 10, lastActivityHoursAgo: 60, blockedReason: 'Client has not signed off on the matching rules', blockerType: 'WAITING_ON_CLIENT', blockedHoursAgo: 60 },
  { project: 'CRM', title: 'Email templates for the follow-up sequence', status: 'READY_FOR_REVIEW', priority: 'LOW', assignee: ARUN, reviewer: AKHIL, progress: 100, dueOffset: 1, estimatedHours: 4, lastActivityHoursAgo: 3 },
  { project: 'CRM', title: 'Activity feed pagination', status: 'ASSIGNED', priority: 'MEDIUM', assignee: FAISAL, reviewer: null, progress: 0, dueOffset: 7, estimatedHours: 6, lastActivityHoursAgo: 20 },
  { project: 'CRM', title: 'Contact merge loses custom fields', status: 'ASSIGNED', priority: 'URGENT', assignee: RAHUL, reviewer: SULTHAN, progress: 0, dueOffset: -1, estimatedHours: 5, lastActivityHoursAgo: 28, labels: ['bug'] },
  { project: 'CRM', title: 'Quarterly pipeline export', status: 'BACKLOG', priority: 'LOW', assignee: null, reviewer: null, progress: 0, dueOffset: null, estimatedHours: 4, lastActivityHoursAgo: 200 },
  { project: 'CRM', title: 'Deal value currency conversion', status: 'COMPLETED', priority: 'HIGH', assignee: AKHIL, reviewer: SULTHAN, progress: 100, dueOffset: -2, estimatedHours: 7, lastActivityHoursAgo: 30, completedDaysAgo: 1 },
  { project: 'CRM', title: 'Remove the unused webhook retry queue', status: 'CANCELLED', priority: 'LOW', assignee: null, reviewer: null, progress: 0, dueOffset: null, estimatedHours: 2, lastActivityHoursAgo: 300, labels: ['tech-debt'] },
];

async function seedTasks(
  projectIds: Map<string, string>,
  userIds: Map<string, string>,
  labelIds: Map<string, string>,
): Promise<number> {
  const leadId = userIds.get(SULTHAN);
  if (!leadId) throw new Error('The team lead must exist before tasks are seeded');

  let created = 0;

  for (const seed of SEED_TASKS) {
    const projectId = projectIds.get(seed.project);
    if (!projectId) continue;

    // Idempotency: a task with this title in this project is left alone.
    const existing = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(sql`${tasks.projectId} = ${projectId}::uuid AND ${tasks.title} = ${seed.title}`)
      .limit(1);

    if (existing.length > 0) continue;

    const [counter] = await db
      .update(projects)
      .set({ taskCounter: sql`${projects.taskCounter} + 1` })
      .where(eq(projects.id, projectId))
      .returning({ number: projects.taskCounter });

    if (!counter) continue;

    const assigneeId = seed.assignee ? userIds.get(seed.assignee) ?? null : null;
    const reviewerId = seed.reviewer ? userIds.get(seed.reviewer) ?? null : null;
    const lastActivityAt = hoursAgo(seed.lastActivityHoursAgo);

    const [task] = await db
      .insert(tasks)
      .values({
        projectId,
        number: counter.number,
        title: seed.title,
        description: 'Seeded task for local development.\n\nReplace with real detail.',
        status: seed.status,
        priority: seed.priority,
        createdBy: leadId,
        assigneeId,
        reviewerId,
        progress: seed.progress,
        dueDate: seed.dueOffset === null ? null : daysFromToday(seed.dueOffset),
        estimatedMinutes: seed.estimatedHours === null ? null : seed.estimatedHours * 60,
        blockedReason: seed.blockedReason ?? null,
        blockerType: seed.blockerType ?? null,
        blockedAt: seed.blockedHoursAgo ? hoursAgo(seed.blockedHoursAgo) : null,
        completedAt: seed.completedDaysAgo ? hoursAgo(seed.completedDaysAgo * 24) : null,
        lastActivityAt,
        createdAt: hoursAgo(seed.lastActivityHoursAgo + 72),
        updatedAt: lastActivityAt,
      })
      .returning({ id: tasks.id });

    if (!task) continue;
    created += 1;

    // Watchers, as the task service would have added them.
    const watchers = [leadId, assigneeId, reviewerId].filter((id): id is string => Boolean(id));
    if (watchers.length > 0) {
      await db
        .insert(taskWatchers)
        .values([...new Set(watchers)].map((userId) => ({ taskId: task.id, userId })))
        .onConflictDoNothing();
    }

    for (const labelName of seed.labels ?? []) {
      const labelId = labelIds.get(labelName);
      if (labelId) {
        await db.insert(taskLabels).values({ taskId: task.id, labelId }).onConflictDoNothing();
      }
    }

    // A believable history, so the timeline is not empty on a fresh install.
    const history: Array<{ action: string; field?: string; oldValue?: unknown; newValue?: unknown; at: Date }> = [
      { action: 'task.created', newValue: { title: seed.title, status: 'BACKLOG' }, at: hoursAgo(seed.lastActivityHoursAgo + 72) },
    ];

    if (assigneeId) {
      history.push({
        action: 'task.assigned',
        field: 'assigneeId',
        oldValue: null,
        newValue: assigneeId,
        at: hoursAgo(seed.lastActivityHoursAgo + 60),
      });
    }

    if (seed.status !== 'BACKLOG' && seed.status !== 'ASSIGNED') {
      history.push({
        action: 'task.transitioned',
        field: 'status',
        oldValue: 'ASSIGNED',
        newValue: 'IN_PROGRESS',
        at: hoursAgo(seed.lastActivityHoursAgo + 48),
      });
    }

    if (seed.status !== 'BACKLOG' && seed.status !== 'ASSIGNED' && seed.status !== 'IN_PROGRESS') {
      history.push({
        action: 'task.transitioned',
        field: 'status',
        oldValue: 'IN_PROGRESS',
        newValue: seed.status,
        at: lastActivityAt,
      });
    }

    if (seed.progress > 0) {
      history.push({
        action: 'task.progress',
        field: 'progress',
        oldValue: 0,
        newValue: seed.progress,
        at: hoursAgo(seed.lastActivityHoursAgo + 12),
      });
    }

    await db.insert(taskActivity).values(
      history.map((entry) => ({
        taskId: task.id,
        actorId: assigneeId ?? leadId,
        action: entry.action,
        field: entry.field ?? null,
        oldValue: entry.oldValue === undefined ? null : entry.oldValue,
        newValue: entry.newValue === undefined ? null : entry.newValue,
        createdAt: entry.at,
      })),
    );

    if (seed.status === 'BLOCKED' && seed.blockedReason) {
      await db.insert(taskComments).values({
        taskId: task.id,
        userId: assigneeId ?? leadId,
        body: seed.blockedReason,
        createdAt: hoursAgo(seed.blockedHoursAgo ?? 24),
      });
    }

    if (seed.status === 'CHANGES_REQUESTED') {
      await db.insert(taskComments).values({
        taskId: task.id,
        userId: leadId,
        body: 'Please add a regression test that covers the cancellation path before resubmitting.',
        createdAt: lastActivityAt,
      });
    }
  }

  return created;
}

async function main(): Promise<void> {
  // Seeded accounts have known passwords. They have no business existing on a
  // real deployment, whatever the operator intended by running this.
  if (env.NODE_ENV === 'production') {
    throw new Error('The seed script refuses to run in production.');
  }

  await seedOrgSettings();
  const userIds = await seedUsers();
  const teamId = await seedTeam(userIds);
  const adminId = userIds.get('admin@example.com');
  if (!adminId) throw new Error('The admin user must exist');

  const projectIds = await seedProjects(teamId, adminId);
  const labelIds = await seedLabels(projectIds);
  const createdTasks = await seedTasks(projectIds, userIds, labelIds);
  const secondTeam = await seedSecondTeam(userIds, adminId);

  logger.info(
    {
      users: userIds.size,
      projects: projectIds.size + 1,
      tasksCreated: createdTasks,
      secondTeamId: secondTeam.teamId,
      timezone: TZ,
    },
    'Seed complete.',
  );
  logger.info(
    'Sign in with sulthan@example.com (team lead) or rahul@example.com (member), password: ' +
      env.SEED_PASSWORD,
  );
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main()
    .then(() => closeDatabase())
    .catch(async (error: unknown) => {
      logger.error({ err: error }, 'Seed failed.');
      await closeDatabase();
      process.exit(1);
    });
}

export { main as seed };
