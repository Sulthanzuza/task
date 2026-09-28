import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Express } from 'express';
import request from 'supertest';
import type { TaskStatus, UserRole } from '@tm/shared';

/**
 * Integration tests run against a real Postgres, started once for the whole file.
 * Mocks would not catch the things that actually break here: constraints, transactions,
 * partial indexes and the concurrency behaviour of the task counter.
 */

let container: StartedPostgreSqlContainer | null = null;

export interface Harness {
  app: Express;
  /** Truncate every table between tests, keeping the schema. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('taskmanager_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  // The connection string must be in place before any module reads the env.
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.NODE_ENV = 'test';
  process.env.JWT_ACCESS_SECRET ||= 'test_secret_used_only_in_tests_0000000000';
  process.env.LOG_LEVEL = 'silent';

  const { runMigrations } = await import('../src/db/migrate');
  await runMigrations();

  const { createApp } = await import('../src/app');
  const { db, closeDatabase } = await import('../src/db/client');
  const { sql } = await import('drizzle-orm');
  const { clearOrgCache } = await import('../src/modules/org/service');

  const app = createApp();

  return {
    app,
    async reset() {
      await db.execute(sql`
        TRUNCATE TABLE
          task_activity, task_comments, comment_mentions, task_attachments,
          task_labels, task_watchers, task_dependencies, task_links, checklist_items,
          time_logs, notifications, notification_preferences, alert_log, saved_views,
          daily_checkins, leaves, tasks, labels, projects, recurring_rules,
          team_members, teams, sessions, password_reset_tokens, users,
          org_settings, holidays
        RESTART IDENTITY CASCADE
      `);
      clearOrgCache();
    },
    async close() {
      await closeDatabase();
      await container?.stop();
      container = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface TestUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  token: string;
}

export interface Fixture {
  team: { id: string };
  otherTeam: { id: string };
  admin: TestUser;
  lead: TestUser;
  otherLead: TestUser;
  member: TestUser;
  reviewer: TestUser;
  outsider: TestUser;
  project: { id: string; key: string };
  otherProject: { id: string; key: string };
}

const PASSWORD = 'Password123!';

/**
 * Two teams, each with its own lead and project, so every test can prove that
 * team A cannot reach team B's data.
 */
export async function seedFixture(app: Express): Promise<Fixture> {
  const { db } = await import('../src/db/client');
  const { hashPassword } = await import('../src/lib/crypto');
  const schema = await import('../src/db/schema');

  await db.insert(schema.orgSettings).values({
    id: 1,
    timezone: 'Asia/Kolkata',
    weekendDays: [0, 6],
    weekStartsOn: 1,
  });

  const passwordHash = await hashPassword(PASSWORD);

  const people = await db
    .insert(schema.users)
    .values([
      { name: 'Admin', email: 'admin@test.local', role: 'SUPER_ADMIN', passwordHash },
      { name: 'Lead A', email: 'lead-a@test.local', role: 'TEAM_LEAD', passwordHash },
      { name: 'Lead B', email: 'lead-b@test.local', role: 'TEAM_LEAD', passwordHash },
      { name: 'Rahul', email: 'rahul@test.local', role: 'MEMBER', passwordHash },
      { name: 'Arun', email: 'arun@test.local', role: 'MEMBER', passwordHash },
      { name: 'Outsider', email: 'outsider@test.local', role: 'MEMBER', passwordHash },
    ])
    .returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.users.role });

  const byEmail = new Map(people.map((p) => [p.email, p]));
  const pick = (email: string) => {
    const found = byEmail.get(email);
    if (!found) throw new Error('Fixture user missing: ' + email);
    return found;
  };

  const teamRows = await db
    .insert(schema.teams)
    .values([
      { name: 'Team A', leadId: pick('lead-a@test.local').id },
      { name: 'Team B', leadId: pick('lead-b@test.local').id },
    ])
    .returning({ id: schema.teams.id, name: schema.teams.name });

  const teamA = teamRows.find((t) => t.name === 'Team A');
  const teamB = teamRows.find((t) => t.name === 'Team B');
  if (!teamA || !teamB) throw new Error('Fixture teams missing');

  await db.insert(schema.teamMembers).values([
    { teamId: teamA.id, userId: pick('lead-a@test.local').id },
    { teamId: teamA.id, userId: pick('rahul@test.local').id },
    { teamId: teamA.id, userId: pick('arun@test.local').id },
    { teamId: teamB.id, userId: pick('lead-b@test.local').id },
    { teamId: teamB.id, userId: pick('outsider@test.local').id },
  ]);

  const projectRows = await db
    .insert(schema.projects)
    .values([
      { key: 'ERP', name: 'ERP', teamId: teamA.id, createdBy: pick('admin@test.local').id },
      { key: 'CRM', name: 'CRM', teamId: teamB.id, createdBy: pick('admin@test.local').id },
    ])
    .returning({ id: schema.projects.id, key: schema.projects.key });

  const erp = projectRows.find((p) => p.key === 'ERP');
  const crm = projectRows.find((p) => p.key === 'CRM');
  if (!erp || !crm) throw new Error('Fixture projects missing');

  const asTestUser = async (email: string): Promise<TestUser> => {
    const row = pick(email);
    return { ...row, token: await login(app, email) };
  };

  return {
    team: { id: teamA.id },
    otherTeam: { id: teamB.id },
    admin: await asTestUser('admin@test.local'),
    lead: await asTestUser('lead-a@test.local'),
    otherLead: await asTestUser('lead-b@test.local'),
    member: await asTestUser('rahul@test.local'),
    reviewer: await asTestUser('arun@test.local'),
    outsider: await asTestUser('outsider@test.local'),
    project: erp,
    otherProject: crm,
  };
}

export async function login(app: Express, email: string, password = PASSWORD): Promise<string> {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(200);
  return response.body.accessToken as string;
}

/** A request helper that carries the bearer token, to keep the tests readable. */
export function as(app: Express, user: TestUser) {
  const auth = (req: request.Test) => req.set('Authorization', 'Bearer ' + user.token);
  return {
    get: (url: string) => auth(request(app).get(url)),
    post: (url: string) => auth(request(app).post(url)),
    patch: (url: string) => auth(request(app).patch(url)),
    put: (url: string) => auth(request(app).put(url)),
    delete: (url: string) => auth(request(app).delete(url)),
  };
}

export async function createTask(
  app: Express,
  user: TestUser,
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; key: string; status: TaskStatus }> {
  const response = await as(app, user)
    .post('/api/v1/projects/' + projectId + '/tasks')
    .send({ title: 'A task that needs doing', ...overrides })
    .expect(201);
  return response.body;
}

export { PASSWORD };
