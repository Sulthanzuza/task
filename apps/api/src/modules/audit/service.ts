import { and, asc, desc, eq, gte, lt, type SQL } from 'drizzle-orm';
import type { Request } from 'express';
import { db, type Db } from '../../db/client';
import { auditLog, users } from '../../db/schema';
import { addDays, zonedTimeToUtc } from '../../lib/date-utils';
import { logger } from '../../lib/logger';
import type { Actor } from '../../middleware/authenticate';
import { authorize } from '../permissions/authorize';
import { getOrgContext } from '../org/service';

/**
 * Recording administrative actions.
 *
 * Deliberately best effort on the write path: failing to log must not stop an
 * admin doing their job, but the failure is logged loudly so a silent gap in
 * the audit trail cannot go unnoticed.
 */

export interface AuditEntry {
  actor: Actor;
  actorEmail?: string | null;
  action: string;
  subjectType: 'user' | 'org_settings' | 'project' | 'team' | 'import';
  subjectId?: string | null;
  before?: unknown;
  after?: unknown;
  req?: Request;
}

export async function recordAudit(entry: AuditEntry, handle: Db = db): Promise<void> {
  try {
    await handle.insert(auditLog).values({
      actorId: entry.actor.id,
      actorEmail: entry.actorEmail ?? null,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId ?? null,
      before: entry.before === undefined ? null : entry.before,
      after: entry.after === undefined ? null : entry.after,
      ip: entry.req?.ip ?? null,
      userAgent: entry.req?.get('user-agent') ?? null,
    });
  } catch (error) {
    logger.error({ err: error, action: entry.action }, 'Could not write the audit log.');
  }
}

export interface AuditRow {
  id: number;
  actorId: string | null;
  /** Resolved for display, because an id tells a reader nothing. */
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  subjectType: string;
  subjectId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

export interface ListAuditOptions {
  limit?: number;
  actorId?: string;
  action?: string;
  /** Inclusive calendar dates in the organisation's time zone. */
  from?: string;
  to?: string;
}

/** The log itself is admin-only: it records who changed other people's access. */
export async function listAudit(
  actor: Actor,
  options: ListAuditOptions = {},
): Promise<{ items: AuditRow[]; actions: string[] }> {
  authorize(actor, 'org.manage', { kind: 'org' });

  const { settings } = await getOrgContext();

  const filters: SQL[] = [];
  if (options.action) filters.push(eq(auditLog.action, options.action));
  if (options.actorId) filters.push(eq(auditLog.actorId, options.actorId));

  /*
   * A date range means whole days where the admin lives, not a UTC window: a
   * change made at 01:00 in Kolkata belongs to that day, not to the one before.
   */
  if (options.from) {
    filters.push(
      gte(auditLog.createdAt, zonedTimeToUtc(options.from, { hour: 0 }, settings.timezone)),
    );
  }
  if (options.to) {
    filters.push(
      lt(
        auditLog.createdAt,
        zonedTimeToUtc(addDays(options.to, 1), { hour: 0 }, settings.timezone),
      ),
    );
  }

  const limit = Math.min(options.limit ?? 100, 500);
  const rows = await db
    .select({
      entry: auditLog,
      actorName: users.name,
      userEmail: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);

  // The filter dropdown offers what has actually happened, not a guess.
  const actions = await db
    .selectDistinct({ action: auditLog.action })
    .from(auditLog)
    .orderBy(asc(auditLog.action));

  return {
    items: rows.map(({ entry, actorName, userEmail }) => ({
      id: entry.id,
      actorId: entry.actorId,
      actorName,
      // The stored email is the one recorded at the time; fall back to the
      // account's current address when the entry did not carry one.
      actorEmail: entry.actorEmail ?? userEmail,
      action: entry.action,
      subjectType: entry.subjectType,
      subjectId: entry.subjectId,
      before: entry.before,
      after: entry.after,
      ip: entry.ip,
      createdAt: entry.createdAt.toISOString(),
    })),
    actions: actions.map((row) => row.action),
  };
}
