import { and, asc, gte, inArray, lte } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { CreateHolidayInput, Holiday } from '@tm/shared';
import { db } from '../../db/client';
import { holidays } from '../../db/schema';
import { NotFoundError } from '../../lib/errors';
import type { Actor } from '../../middleware/authenticate';
import { authorize } from '../permissions/authorize';
import { recordAudit } from '../audit/service';
import { clearOrgCache } from './service';

/**
 * The holiday calendar.
 *
 * Every working-day calculation in the system reads this table through
 * org/service, so a change here moves due dates, overdue alerts and the
 * workload window. That is why each change is audited and the cache is dropped
 * immediately rather than left to expire.
 */

export async function listHolidays(year?: number): Promise<Holiday[]> {
  const filters =
    year === undefined
      ? undefined
      : and(
          gte(holidays.date, String(year) + '-01-01'),
          lte(holidays.date, String(year) + '-12-31'),
        );

  const rows = await db
    .select({ date: holidays.date, name: holidays.name })
    .from(holidays)
    .where(filters)
    .orderBy(asc(holidays.date));

  return rows;
}

export async function addHolidays(
  actor: Actor,
  items: CreateHolidayInput[],
): Promise<{ added: number; alreadyThere: number; items: Holiday[] }> {
  authorize(actor, 'org.manage', { kind: 'org' });

  // The same day twice in one paste is the user's typo, not a reason to fail.
  const unique = new Map<string, CreateHolidayInput>();
  for (const item of items) unique.set(item.date, item);
  const values = [...unique.values()];

  const existing = await db
    .select({ date: holidays.date })
    .from(holidays)
    .where(
      inArray(
        holidays.date,
        values.map((v) => v.date),
      ),
    );

  const alreadyThere = new Set(existing.map((row) => row.date));

  const inserted = await db
    .insert(holidays)
    .values(values)
    .onConflictDoNothing()
    .returning({ date: holidays.date, name: holidays.name });

  clearOrgCache();

  if (inserted.length > 0) {
    await recordAudit({
      actor,
      action: 'holidays.added',
      subjectType: 'org_settings',
      subjectId: '1',
      after: { dates: inserted.map((row) => row.date) },
    });
  }

  return {
    added: inserted.length,
    alreadyThere: alreadyThere.size,
    items: await listHolidays(),
  };
}

export async function removeHoliday(actor: Actor, date: string): Promise<void> {
  authorize(actor, 'org.manage', { kind: 'org' });

  const removed = await db
    .delete(holidays)
    .where(eq(holidays.date, date))
    .returning({ date: holidays.date, name: holidays.name });

  if (removed.length === 0) throw new NotFoundError('That holiday');

  clearOrgCache();

  await recordAudit({
    actor,
    action: 'holidays.removed',
    subjectType: 'org_settings',
    subjectId: '1',
    before: removed[0],
  });
}
