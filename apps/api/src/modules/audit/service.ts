import { desc, eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { db, type Db } from '../../db/client';
import { auditLog } from '../../db/schema';
import { logger } from '../../lib/logger';
import type { Actor } from '../../middleware/authenticate';
import { authorize } from '../permissions/authorize';

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
  actorEmail: string | null;
  action: string;
  subjectType: string;
  subjectId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

/** The log itself is admin-only: it records who changed other people's access. */
export async function listAudit(
  actor: Actor,
  options: { limit?: number; action?: string } = {},
): Promise<{ items: AuditRow[] }> {
  authorize(actor, 'org.manage', { kind: 'org' });

  const limit = Math.min(options.limit ?? 100, 500);
  const rows = await db
    .select()
    .from(auditLog)
    .where(options.action ? eq(auditLog.action, options.action) : sql`true`)
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);

  return {
    items: rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorEmail: row.actorEmail,
      action: row.action,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      before: row.before,
      after: row.after,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
