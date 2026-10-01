import { eq, sql } from 'drizzle-orm';
import type { BlockerType, TaskPriority, TaskStatus } from '@tm/shared';
import { db } from './client';
import {
  holidays,
  labels,
  leaves,
  projects,
  taskActivity,
  taskComments,
  taskLabels,
  taskWatchers,
  tasks,
  users,
} from './schema';
import { env } from '../config/env';
import { addDays, toDateOnly } from '../lib/date-utils';
import { logger } from '../lib/logger';

/**
 * Twelve weeks of plausible history, for looking at the dashboard.
 *
 * The ordinary seed is deliberately small: it is what the end-to-end tests
 * count, so every task in it is one somebody asserts on. That makes it useless
 * for judging a chart, because eleven of the twelve bars are empty.
 *
 * This adds bulk on top of it, and is never run by the tests. It is
 * deterministic: the same command produces the same database, so a screenshot
 * taken today can be compared with one taken next week. Dates are relative to
 * now, so the charts stay populated however long the checkout sits.
 */

/** mulberry32: small, fast and fixed, so "random" here means "arbitrary but repeatable". */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260930;
const WEEKS = 12;

/**
 * Marks every task this file creates, so a re-run can recognise its own work.
 *
 * It lives on the created-activity row rather than in the title. It used to
 * be a "[demo]" suffix, which meant every title on every screen announced
 * that the data was fake and ate the width a real title needed.
 */
const DEMO_MARKER = { demo: true } as const;

const SUBJECTS = [
  'Reconcile supplier ledger for',
  'Add VAT breakdown to',
  'Fix rounding error in',
  'Speed up the export for',
  'Write the migration guide for',
  'Handle partial refunds in',
  'Tidy the audit trail on',
  'Add pagination to',
  'Cache the lookup used by',
  'Retire the legacy path in',
  'Improve the error message on',
  'Backfill missing rows in',
  'Add a regression test for',
  'Split the batch job behind',
  'Rework permissions around',
];

/**
 * A third word, so there are enough combinations to go round.
 *
 * Fifteen verbs and twelve nouns is 180 titles for about 200 tasks, and the
 * old code papered over the shortfall by sticking the task's index on the
 * end: "Add pagination to the tax report 161". Three lists give well over a
 * thousand, drawn without replacement, so every title is unique and none of
 * them has a number glued to it.
 */
const QUALIFIERS = [
  '',
  ' for the EU rollout',
  ' before the quarter close',
  ' on the mobile layout',
  ' in the nightly run',
  ' for large accounts',
  ' after the migration',
  ' in the reconciliation step',
];

const OBJECTS = [
  'the invoice screen',
  'the credit note flow',
  'the stock ledger',
  'the customer portal',
  'the pipeline board',
  'the contact merge',
  'the nightly export',
  'the tax report',
  'the purchase order form',
  'the supplier master',
  'the activity feed',
  'the deduplication rules',
];

const BLOCKER_REASONS: Record<BlockerType, string> = {
  DEPENDENCY: 'Waiting on the schema change in the platform release.',
  EXTERNAL: 'The payment provider has not enabled the sandbox account yet.',
  WAITING_ON_CLIENT: 'The client has not signed off on the matching rules.',
  WAITING_ON_PERSON: 'Waiting on the finance team for last quarter’s figures.',
  OTHER: 'Parked until the pricing decision is made.',
};

const MEMBERS = [
  'rahul@example.com',
  'arun@example.com',
  'faisal@example.com',
  'akhil@example.com',
];

const LABEL_NAMES = ['bug', 'feature', 'tech-debt', 'invoicing'];

interface Plan {
  title: string;
  project: 'ERP' | 'CRM';
  assignee: string;
  reviewer: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  progress: number;
  estimateHours: number | null;
  labels: string[];
  createdAt: Date;
  dueDate: string | null;
  completedAt: Date | null;
  blockerType: BlockerType | null;
  lastActivityAt: Date;
}

const PRIORITIES: TaskPriority[] = ['LOW', 'MEDIUM', 'MEDIUM', 'HIGH', 'HIGH', 'URGENT'];

/** Draw one of a list, using the sequence rather than the clock. */
function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)] as T;
}

/**
 * Build the whole plan before writing anything.
 *
 * Older weeks are mostly finished and recent ones mostly in flight, which is
 * what a real backlog looks like and what makes the twelve bars tell a story
 * rather than sit flat.
 */
function planTasks(now: Date, timezone: string): Plan[] {
  const random = makeRandom(SEED);
  const today = toDateOnly(now, timezone);
  const plans: Plan[] = [];

  // Cycled over the blocked tasks themselves, not over every task, so all five
  // reasons actually appear rather than whichever the dice happened to land on.
  const BLOCKER_CYCLE = [
    'DEPENDENCY',
    'EXTERNAL',
    'WAITING_ON_CLIENT',
    'WAITING_ON_PERSON',
    'OTHER',
  ] as const;
  let blockedSoFar = 0;

  const weekday = new Date(today + 'T00:00:00Z').getUTCDay();
  // Monday-based, so a Wednesday is three days into the week.
  const daysElapsed = (weekday + 6) % 7;

  /*
   * Every combination, shuffled once with the same seeded generator, then
   * handed out in order. Drawing at random would repeat long before the
   * list ran out, and a repeated title in a list of tasks reads as a bug.
   */
  const titlePool: string[] = [];
  for (const subject of SUBJECTS) {
    for (const object of OBJECTS) {
      for (const qualifier of QUALIFIERS) titlePool.push(subject + ' ' + object + qualifier);
    }
  }
  for (let i = titlePool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [titlePool[i], titlePool[j]] = [titlePool[j] as string, titlePool[i] as string];
  }
  let titleAt = 0;
  const nextTitle = (): string => {
    const title = titlePool[titleAt % titlePool.length] as string;
    titleAt += 1;
    return title;
  };

  const common = (createdAt: Date) => {
    const chosenLabels: string[] = [];
    if (random() < 0.85) chosenLabels.push(pick(random, LABEL_NAMES));
    if (random() < 0.25) {
      const second = pick(random, LABEL_NAMES);
      if (!chosenLabels.includes(second)) chosenLabels.push(second);
    }
    return {
      title: nextTitle(),
      project: (random() < 0.55 ? 'ERP' : 'CRM') as Plan['project'],
      assignee: pick(random, MEMBERS),
      reviewer: random() < 0.6 ? 'sulthan@example.com' : null,
      priority: pick(random, PRIORITIES),
      estimateHours:
        random() < 0.85 ? ([1, 2, 3, 4, 6, 8, 12, 16][Math.floor(random() * 8)] as number) : null,
      labels: chosenLabels,
      createdAt,
    };
  };

  /*
   * Completions are planned week by week rather than falling out of the due
   * dates. A steady eight to twelve a week is what a working team looks like;
   * deriving them from due dates gave anything from two to sixteen, which
   * makes the throughput chart look broken rather than informative.
   */
  for (let weeksAgo = WEEKS - 1; weeksAgo >= 0; weeksAgo -= 1) {
    const full = 8 + Math.floor(random() * 5);
    // The current week is only partly over, so it gets a proportional share.
    const target = weeksAgo === 0 ? Math.max(1, Math.round((full * (daysElapsed + 1)) / 7)) : full;

    for (let index = 0; index < target; index += 1) {
      // Finished this week, having started one to three weeks before.
      const dayInWeek =
        weeksAgo === 0 ? Math.floor(random() * (daysElapsed + 1)) : Math.floor(random() * 7);
      const completedOffset = -(weeksAgo * 7) + dayInWeek - daysElapsed;

      const startedOffset = completedOffset - (3 + Math.floor(random() * 18));
      const createdAt = new Date(
        now.getTime() + startedOffset * 86_400_000 - Math.floor(random() * 8) * 3_600_000,
      );

      // Three in four met the date; the rest slipped.
      const onTime = random() < 0.75;
      const dueOffset = onTime
        ? completedOffset + Math.floor(random() * 4)
        : completedOffset - (1 + Math.floor(random() * 6));

      let completedAt = new Date(
        now.getTime() + completedOffset * 86_400_000 - Math.floor(random() * 9) * 3_600_000,
      );
      if (completedAt.getTime() > now.getTime()) completedAt = new Date(now.getTime() - 3_600_000);
      if (completedAt.getTime() < createdAt.getTime()) {
        completedAt = new Date(createdAt.getTime() + 6 * 3_600_000);
      }

      const base = common(createdAt);
      const cancelled = random() < 0.05;

      plans.push({
        ...base,
        title: base.title,
        status: cancelled ? 'CANCELLED' : 'COMPLETED',
        progress: cancelled ? Math.floor(random() * 60) : 100,
        dueDate: addDays(today, dueOffset),
        completedAt: cancelled ? null : completedAt,
        blockerType: null,
        lastActivityAt: completedAt,
      });
    }
  }

  /*
   * The open backlog. Due dates run over the next three weeks so that every
   * member has something in the due-load grid, with only about one in eight
   * already past its date.
   */
  const OPEN_TASKS = 62;

  for (let index = 0; index < OPEN_TASKS; index += 1) {
    const startedOffset = -Math.floor(random() * 28);
    const createdAt = new Date(
      now.getTime() + startedOffset * 86_400_000 - Math.floor(random() * 8) * 3_600_000,
    );

    const overdue = random() < 0.1;
    const dueOffset = overdue ? -(1 + Math.floor(random() * 9)) : Math.floor(random() * 21);

    let status: TaskStatus;
    let progress: number;
    let blockerType: BlockerType | null = null;

    const roll = random();
    if (roll < 0.09 && blockedSoFar < 5) {
      status = 'BLOCKED';
      blockerType = BLOCKER_CYCLE[blockedSoFar % BLOCKER_CYCLE.length] as BlockerType;
      blockedSoFar += 1;
      progress = 20 + Math.floor(random() * 50);
    } else if (roll < 0.22) {
      status = 'READY_FOR_REVIEW';
      progress = 100;
    } else if (roll < 0.32) {
      status = 'IN_REVIEW';
      progress = 100;
    } else if (roll < 0.4) {
      status = 'CHANGES_REQUESTED';
      progress = 80;
    } else if (roll < 0.78) {
      status = 'IN_PROGRESS';
      progress = 10 + Math.floor(random() * 80);
    } else if (roll < 0.92) {
      status = 'ASSIGNED';
      progress = 0;
    } else {
      status = 'BACKLOG';
      progress = 0;
    }

    const base = common(createdAt);
    const lastActivityAt = new Date(now.getTime() - Math.floor(random() * 96) * 3_600_000);

    plans.push({
      ...base,
      title: base.title,
      status,
      progress,
      dueDate: addDays(today, dueOffset),
      completedAt: null,
      blockerType,
      lastActivityAt: lastActivityAt < createdAt ? createdAt : lastActivityAt,
    });
  }

  return plans;
}

/**
 * Leave and a holiday inside the heatmap window, so the greyed-out cells and
 * the leave-aware alerts have something to show.
 */
async function seedAbsences(userIds: Map<string, string>, now: Date, timezone: string) {
  const today = toDateOnly(now, timezone);

  await db
    .insert(holidays)
    .values({ date: addDays(today, 6), name: 'Founders’ Day [demo]' })
    .onConflictDoNothing();

  const away: Array<[string, number, number, 'ANNUAL' | 'SICK']> = [
    ['arun@example.com', 2, 3, 'ANNUAL'],
    ['akhil@example.com', 5, 5, 'SICK'],
  ];

  for (const [email, from, to, type] of away) {
    const userId = userIds.get(email);
    if (!userId) continue;

    const startDate = addDays(today, from);
    const existing = await db
      .select({ id: leaves.id })
      .from(leaves)
      .where(sql`${leaves.userId} = ${userId}::uuid AND ${leaves.startDate} = ${startDate}::date`)
      .limit(1);
    if (existing.length > 0) continue;

    await db.insert(leaves).values({
      userId,
      startDate,
      endDate: addDays(today, to),
      type,
      note: 'Demo leave',
    });
  }
}

export interface DemoResult {
  created: number;
  skipped: number;
}

export async function seedDemo(now = new Date()): Promise<DemoResult> {
  // The ordinary seed refuses production for the same reason; so does this.
  if (env.NODE_ENV === 'production') {
    throw new Error('The demo seed refuses to run in production.');
  }

  const timezone = env.SEED_TIMEZONE;

  const people = await db.select({ id: users.id, email: users.email }).from(users);
  const userIds = new Map(people.map((person) => [person.email.toLowerCase(), person.id]));

  const leadId = userIds.get('sulthan@example.com');
  if (!leadId) throw new Error('Run the ordinary seed before the demo seed.');

  const projectRows = await db.select({ id: projects.id, key: projects.key }).from(projects);
  const projectIds = new Map(projectRows.map((project) => [project.key, project.id]));

  const labelRows = await db.select({ id: labels.id, name: labels.name }).from(labels);
  const labelIds = new Map(labelRows.map((label) => [label.name, label.id]));

  const [already] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(taskActivity)
    .where(sql`${taskActivity.meta} @> ${JSON.stringify(DEMO_MARKER)}::jsonb`);

  if ((already?.n ?? 0) > 0) {
    logger.info({ existing: already?.n }, 'Demo data is already present; nothing to add.');
    return { created: 0, skipped: already?.n ?? 0 };
  }

  await seedAbsences(userIds, now, timezone);

  const plans = planTasks(now, timezone);
  let created = 0;

  for (const plan of plans) {
    const projectId = projectIds.get(plan.project);
    if (!projectId) continue;

    const [counter] = await db
      .update(projects)
      .set({ taskCounter: sql`${projects.taskCounter} + 1` })
      .where(eq(projects.id, projectId))
      .returning({ number: projects.taskCounter });
    if (!counter) continue;

    const assigneeId = userIds.get(plan.assignee) ?? null;
    const reviewerId = plan.reviewer ? (userIds.get(plan.reviewer) ?? null) : null;

    const [task] = await db
      .insert(tasks)
      .values({
        projectId,
        number: counter.number,
        title: plan.title,
        description:
          'Generated for the demo dataset.\n\n' +
          'It carries a real history so the timeline, the charts and the ' +
          'completion times all agree with each other.',
        status: plan.status,
        priority: plan.priority,
        createdBy: leadId,
        assigneeId,
        reviewerId,
        progress: plan.progress,
        dueDate: plan.dueDate,
        estimatedMinutes: plan.estimateHours === null ? null : plan.estimateHours * 60,
        blockedReason: plan.blockerType ? BLOCKER_REASONS[plan.blockerType] : null,
        blockerType: plan.blockerType,
        blockedAt: plan.blockerType
          ? new Date(plan.lastActivityAt.getTime() - 36 * 3_600_000)
          : null,
        completedAt: plan.completedAt,
        lastActivityAt: plan.lastActivityAt,
        createdAt: plan.createdAt,
        updatedAt: plan.lastActivityAt,
      })
      .returning({ id: tasks.id });

    if (!task) continue;
    created += 1;

    const watchers = [
      ...new Set([leadId, assigneeId, reviewerId].filter((id): id is string => Boolean(id))),
    ];
    await db
      .insert(taskWatchers)
      .values(watchers.map((userId) => ({ taskId: task.id, userId })))
      .onConflictDoNothing();

    for (const name of plan.labels) {
      const labelId = labelIds.get(name);
      if (labelId) {
        await db.insert(taskLabels).values({ taskId: task.id, labelId }).onConflictDoNothing();
      }
    }

    /*
     * The history matches the row. Completion times in particular have to be
     * real, because the cycle-time and on-time figures are read from them.
     */
    const history: Array<{
      action: string;
      field?: string;
      oldValue?: unknown;
      newValue?: unknown;
      meta?: Record<string, unknown>;
      at: Date;
    }> = [
      {
        action: 'task.created',
        newValue: { title: plan.title, status: 'BACKLOG' },
        // The only trace that this row was generated, and nobody reads it.
        meta: DEMO_MARKER,
        at: plan.createdAt,
      },
    ];

    const startedAt = new Date(plan.createdAt.getTime() + 6 * 3_600_000);

    if (assigneeId) {
      history.push({
        action: 'task.assigned',
        field: 'assigneeId',
        oldValue: null,
        newValue: assigneeId,
        at: new Date(plan.createdAt.getTime() + 2 * 3_600_000),
      });
    }

    if (plan.status !== 'BACKLOG' && plan.status !== 'ASSIGNED') {
      history.push({
        action: 'task.transitioned',
        field: 'status',
        oldValue: 'ASSIGNED',
        newValue: 'IN_PROGRESS',
        at: startedAt,
      });
    }

    if (plan.progress > 0) {
      history.push({
        action: 'task.progress',
        field: 'progress',
        oldValue: 0,
        newValue: plan.progress,
        at: new Date(startedAt.getTime() + 3_600_000),
      });
    }

    if (plan.completedAt) {
      history.push({
        action: 'task.transitioned',
        field: 'status',
        oldValue: 'IN_REVIEW',
        newValue: plan.status,
        at: plan.completedAt,
      });
    } else if (!['BACKLOG', 'ASSIGNED', 'IN_PROGRESS'].includes(plan.status)) {
      history.push({
        action: 'task.transitioned',
        field: 'status',
        oldValue: 'IN_PROGRESS',
        newValue: plan.status,
        at: plan.lastActivityAt,
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
        meta: entry.meta ?? null,
        createdAt: entry.at,
      })),
    );

    if (plan.blockerType) {
      await db.insert(taskComments).values({
        taskId: task.id,
        userId: assigneeId ?? leadId,
        body: BLOCKER_REASONS[plan.blockerType],
        createdAt: new Date(plan.lastActivityAt.getTime() - 36 * 3_600_000),
      });
    }
  }

  logger.info({ created }, 'Demo data added.');
  return { created, skipped: 0 };
}
