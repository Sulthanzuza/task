import { inArray } from 'drizzle-orm';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  formatTaskKey,
  type TaskPriority,
  type TaskStatus,
} from '@tm/shared';
import { db, withTransaction } from '../../db/client';
import { projects, taskWatchers, tasks, users } from '../../db/schema';
import { ConflictError, ForbiddenError, ValidationError } from '../../lib/errors';
import type { Actor } from '../../middleware/authenticate';
import { recordAudit } from '../audit/service';
import * as taskRepo from '../tasks/repo';

/**
 * Importing work that already exists somewhere else.
 *
 * Nothing is written until the operator has seen exactly what will happen.
 * A spreadsheet from another system is always partly wrong, so the useful
 * output is not "imported 40 tasks" but "row 12 has an assignee nobody
 * recognises" before anything lands.
 */

export const IMPORT_COLUMNS = [
  'title',
  'project key',
  'assignee email',
  'priority',
  'status',
  'due date',
  'estimate hours',
] as const;

export interface ImportRow {
  /** 1-based, counting the header, so it matches what the operator sees. */
  rowNumber: number;
  title: string;
  projectKey: string;
  assigneeEmail: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate: string | null;
  estimateHours: number | null;
}

export interface RowProblem {
  rowNumber: number;
  column: string;
  message: string;
}

export interface ImportPreview {
  /** Rows that would be created. */
  ready: ImportRow[];
  problems: RowProblem[];
  totalRows: number;
}

export interface ImportResult extends ImportPreview {
  created: Array<{ rowNumber: number; taskKey: string }>;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A small CSV reader: quoted fields, doubled quotes, and embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // A spreadsheet exported from Excel starts with a byte order mark, which
  // would otherwise become part of the first header. Compared by code point,
  // because a literal one in the source is invisible.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheet = workbook.worksheets[0];
  if (!sheet) throw new ValidationError('That spreadsheet has no sheets.');

  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const value = cell.value;
      if (value === null || value === undefined) {
        values.push('');
      } else if (value instanceof Date) {
        values.push(value.toISOString().slice(0, 10));
      } else if (typeof value === 'object' && 'text' in value) {
        values.push(String((value as { text: unknown }).text));
      } else if (typeof value === 'object' && 'result' in value) {
        values.push(String((value as { result: unknown }).result ?? ''));
      } else {
        values.push(String(value));
      }
    });
    rows.push(values);
  });

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Header names are matched loosely, so "Due Date" and "due_date" both work. */
function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

const HEADER_ALIASES: Record<string, string> = {
  title: 'title',
  summary: 'title',
  task: 'title',
  'project key': 'project key',
  project: 'project key',
  'assignee email': 'assignee email',
  assignee: 'assignee email',
  email: 'assignee email',
  priority: 'priority',
  status: 'status',
  'due date': 'due date',
  due: 'due date',
  'estimate hours': 'estimate hours',
  estimate: 'estimate hours',
  hours: 'estimate hours',
};

function parseDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // Accept the common European and ISO-ish forms; reject anything ambiguous.
  const dmy = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(trimmed);
  if (dmy) {
    const [, d, m, y] = dmy;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ParseOptions {
  fileName: string;
  buffer: Buffer;
}

export async function readRows(options: ParseOptions): Promise<string[][]> {
  const isXlsx = /\.xlsx$/i.test(options.fileName);
  return isXlsx ? parseXlsx(options.buffer) : parseCsv(options.buffer.toString('utf8'));
}

/**
 * Turn a sheet into rows we could write, plus everything wrong with it.
 *
 * Every problem is reported, not just the first, so one pass over the file
 * tells the operator everything they have to fix. Committing then refuses the
 * whole file while any problem remains: half an import is worse than none.
 */
export async function validateRows(actor: Actor, grid: string[][]): Promise<ImportPreview> {
  if (grid.length === 0) throw new ValidationError('That file has no rows.');

  const header = (grid[0] as string[]).map((cell) => HEADER_ALIASES[normaliseHeader(cell)] ?? '');
  const missing = ['title', 'project key'].filter((needed) => !header.includes(needed));
  if (missing.length > 0) {
    throw new ValidationError('The sheet needs a column for ' + missing.join(' and ') + '.', {
      expected: IMPORT_COLUMNS,
    });
  }

  const index = (name: string) => header.indexOf(name);
  const body = grid.slice(1);

  // Look everything up once rather than per row.
  const projectRows = await db
    .select({ id: projects.id, key: projects.key, teamId: projects.teamId })
    .from(projects);
  const projectsByKey = new Map(projectRows.map((p) => [p.key.toUpperCase(), p]));

  const emails = [
    ...new Set(
      body
        .map((row) => (index('assignee email') >= 0 ? row[index('assignee email')] : '') ?? '')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const userRows = emails.length
    ? await db
        .select({ id: users.id, email: users.email, isActive: users.isActive })
        .from(users)
        .where(inArray(users.email, emails))
    : [];
  const usersByEmail = new Map(userRows.map((u) => [u.email.toLowerCase(), u]));

  const ready: ImportRow[] = [];
  const problems: RowProblem[] = [];

  body.forEach((raw, offset) => {
    const rowNumber = offset + 2; // The header is row 1.
    const cell = (name: string): string => {
      const at = index(name);
      return at >= 0 ? (raw[at] ?? '').trim() : '';
    };

    const rowProblems: RowProblem[] = [];
    const add = (column: string, message: string) =>
      rowProblems.push({ rowNumber, column, message });

    const title = cell('title');
    if (title.length < 3) add('title', 'A title of at least 3 characters is required.');
    if (title.length > 300) add('title', 'That title is longer than 300 characters.');

    const projectKey = cell('project key').toUpperCase();
    const project = projectsByKey.get(projectKey);
    if (!projectKey) {
      add('project key', 'A project key is required.');
    } else if (!project) {
      add('project key', 'No project has the key ' + projectKey + '.');
    } else if (!can(actor, project.teamId)) {
      add('project key', 'You cannot create tasks in ' + projectKey + '.');
    }

    const assigneeEmail = cell('assignee email').toLowerCase() || null;
    if (assigneeEmail) {
      const person = usersByEmail.get(assigneeEmail);
      if (!person) add('assignee email', 'Nobody here uses ' + assigneeEmail + '.');
      else if (!person.isActive) add('assignee email', assigneeEmail + ' is deactivated.');
    }

    const priorityRaw = cell('priority').toUpperCase();
    const priority = (priorityRaw || 'MEDIUM') as TaskPriority;
    if (!TASK_PRIORITIES.includes(priority)) {
      add('priority', 'Priority must be one of ' + TASK_PRIORITIES.join(', ') + '.');
    }

    const statusRaw = cell('status')
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    const status = (statusRaw || (assigneeEmail ? 'ASSIGNED' : 'BACKLOG')) as TaskStatus;
    if (!TASK_STATUSES.includes(status)) {
      add('status', 'Status must be one of ' + TASK_STATUSES.join(', ') + '.');
    } else if (status === 'COMPLETED' || status === 'CANCELLED') {
      add('status', 'Only open tasks can be imported.');
    }

    const dueRaw = cell('due date');
    const dueDate = parseDate(dueRaw);
    if (dueRaw && !dueDate) {
      add('due date', 'Use YYYY-MM-DD; ' + dueRaw + ' is ambiguous.');
    }

    const estimateRaw = cell('estimate hours');
    const estimateHours = estimateRaw ? Number(estimateRaw) : null;
    if (estimateRaw && (!Number.isFinite(estimateHours) || (estimateHours ?? 0) < 0)) {
      add('estimate hours', 'An estimate must be a number of hours.');
    }

    if (rowProblems.length > 0) {
      problems.push(...rowProblems);
      return;
    }

    ready.push({
      rowNumber,
      title,
      projectKey,
      assigneeEmail,
      priority,
      status,
      dueDate,
      estimateHours,
    });
  });

  return { ready, problems, totalRows: body.length };
}

/** Can this actor create tasks in a project owned by this team? */
function can(actor: Actor, teamId: string): boolean {
  if (actor.role === 'SUPER_ADMIN') return true;
  return actor.role === 'TEAM_LEAD' && actor.ledTeamIds.includes(teamId);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Write the import.
 *
 * All of it or none of it, in one transaction. A half-finished import is worse
 * than none, because nobody can tell which half landed; and importing the good
 * rows while quietly dropping the bad ones leaves the operator believing their
 * spreadsheet went in whole.
 */
export async function commitImport(
  actor: Actor,
  preview: ImportPreview,
  now = new Date(),
): Promise<ImportResult> {
  if (preview.problems.length > 0) {
    const rows = [...new Set(preview.problems.map((problem) => problem.rowNumber))].sort(
      (a, b) => a - b,
    );
    throw new ConflictError(
      'Nothing was imported. Fix ' +
        (rows.length === 1 ? 'row ' : 'rows ') +
        rows.join(', ') +
        ' and try again.',
      { problems: preview.problems },
    );
  }

  if (preview.ready.length === 0) {
    return { ...preview, created: [] };
  }

  const created = await withTransaction(async (tx) => {
    const results: Array<{ rowNumber: number; taskKey: string }> = [];

    const projectRows = await tx
      .select({ id: projects.id, key: projects.key, teamId: projects.teamId })
      .from(projects);
    const projectsByKey = new Map(projectRows.map((p) => [p.key.toUpperCase(), p]));

    /*
     * Check the authority again here, against the rows about to be written.
     * validateRows has already refused any project the actor may not use, but
     * this function takes a preview as an argument: it must not depend on its
     * caller having produced that preview honestly.
     */
    for (const row of preview.ready) {
      const project = projectsByKey.get(row.projectKey);
      if (!project || !can(actor, project.teamId)) {
        throw new ForbiddenError('You cannot create tasks in ' + row.projectKey + '.');
      }
    }

    const emails = [...new Set(preview.ready.map((r) => r.assigneeEmail).filter(Boolean))];
    const userRows = emails.length
      ? await tx
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.email, emails as string[]))
      : [];
    const usersByEmail = new Map(userRows.map((u) => [u.email.toLowerCase(), u.id]));

    for (const row of preview.ready) {
      const project = projectsByKey.get(row.projectKey);
      if (!project) continue;

      const number = await taskRepo.allocateTaskNumber(tx, project.id);
      const assigneeId = row.assigneeEmail ? (usersByEmail.get(row.assigneeEmail) ?? null) : null;

      const [task] = await tx
        .insert(tasks)
        .values({
          projectId: project.id,
          number,
          title: row.title,
          status: row.status,
          priority: row.priority,
          createdBy: actor.id,
          assigneeId,
          dueDate: row.dueDate,
          estimatedMinutes: row.estimateHours === null ? null : Math.round(row.estimateHours * 60),
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: tasks.id });

      if (!task) continue;

      await tx
        .insert(taskWatchers)
        .values(
          [actor.id, assigneeId]
            .filter((id): id is string => Boolean(id))
            .map((userId) => ({ taskId: task.id, userId })),
        )
        .onConflictDoNothing();

      // An imported task says so in its history, so nobody later wonders why
      // it appeared with no author.
      await taskRepo.writeActivity(
        tx,
        [
          {
            taskId: task.id,
            actorId: actor.id,
            action: 'task.imported',
            newValue: {
              source: 'spreadsheet',
              row: row.rowNumber,
              title: row.title,
              status: row.status,
            },
          },
        ],
        now,
      );

      results.push({ rowNumber: row.rowNumber, taskKey: formatTaskKey(project.key, number) });
    }

    return results;
  });

  await recordAudit({
    actor,
    action: 'tasks.imported',
    subjectType: 'import',
    after: { created: created.length, skipped: preview.problems.length },
  });

  return { ...preview, created };
}
