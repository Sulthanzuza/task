import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  bulkHolidaysSchema,
  createHolidaySchema,
  dateOnlySchema,
  listAuditQuerySchema,
  updateOrgSettingsSchema,
  uuidSchema,
  type BulkHolidaysInput,
  type CreateHolidayInput,
  type ListAuditQuery,
  type UpdateOrgSettingsInput,
} from '@tm/shared';
import { isTest } from '../../config/env';
import { db } from '../../db/client';
import { users } from '../../db/schema';
import { orgSettings } from '../../db/schema';
import { NotFoundError, ValidationError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { authenticate, requireActor, requireRole } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import { authorize } from '../permissions/authorize';
import { buildDigest } from '../alerts/digest';
import { clearOrgCache, getOrgSettings } from './service';
import { listAudit, recordAudit } from '../audit/service';
import { addHolidays, listHolidays, removeHoliday } from './holidays';
import { isRunnableJob, rescheduleAfterSettingsChange, runJob } from '../../jobs/scheduler';

export const orgRouter: Router = Router();

orgRouter.use(authenticate);

orgRouter.get(
  '/settings',
  handler(async (req, res) => {
    authorize(requireActor(req), 'org.manage', { kind: 'org' });
    res.json(await getOrgSettings());
  }),
);

orgRouter.patch(
  '/settings',
  requireRole('SUPER_ADMIN'),
  validate({ body: updateOrgSettingsSchema }),
  handler(async (req, res) => {
    const input = req.body as UpdateOrgSettingsInput;
    const before = await getOrgSettings();

    const changes: Record<string, unknown> = { updatedAt: new Date() };
    for (const [key, value] of Object.entries(input)) {
      changes[key] = key === 'workHoursPerDay' ? String(value) : value;
    }
    if (input.digestTime && input.digestTime.length === 5) {
      changes.digestTime = input.digestTime + ':00';
    }

    // org_settings holds exactly one row, with id 1.
    await db.update(orgSettings).set(changes).where(eq(orgSettings.id, 1));
    clearOrgCache();

    const after = await getOrgSettings();

    await recordAudit({
      actor: requireActor(req),
      action: 'org_settings.updated',
      subjectType: 'org_settings',
      subjectId: '1',
      before,
      after,
      req,
    });

    /*
     * The time zone and the digest time are baked into the schedule rows, so a
     * change to either has to be pushed into pg-boss. Leaving it to the next
     * restart would mean the digest kept arriving at the old hour.
     */
    if (before.timezone !== after.timezone || before.digestTime !== after.digestTime) {
      try {
        await rescheduleAfterSettingsChange();
      } catch (error) {
        logger.error({ err: error }, 'Settings saved, but rescheduling failed.');
      }
    }

    res.json(after);
  }),
);

/**
 * The digest a person would receive, built without sending anything and
 * without writing to alert_log or digest_log. It is the same code path the job
 * uses, which is what makes the preview worth looking at.
 */
orgRouter.get(
  '/digest-preview',
  validate({
    query: z.object({
      userId: uuidSchema.optional(),
      date: dateOnlySchema.optional(),
    }),
  }),
  handler(async (req, res) => {
    const actor = requireActor(req);
    const { userId, date } = req.query as { userId?: string; date?: string };

    // Anyone may preview their own; only an admin may preview someone else's.
    const target = userId ?? actor.id;
    if (target !== actor.id) authorize(actor, 'org.manage', { kind: 'org' });

    const settings = await getOrgSettings();
    const now = date
      ? await (async () => {
          const { zonedTimeToUtc } = await import('../../lib/date-utils');
          const [hour = '9'] = settings.digestTime.split(':');
          return zonedTimeToUtc(date, { hour: Number(hour) }, settings.timezone);
        })()
      : new Date();

    res.json(await buildDigest(target, now));
  }),
);

/**
 * Runs a scheduled job with an explicit clock, for end-to-end tests.
 *
 * Not mounted at all outside a test build. A guard inside the handler would
 * still leave the route in the routing table, discoverable and one refactor
 * away from being reachable; a route that can make the system believe it is a
 * different day should simply not exist in production.
 */
if (isTest) {
  orgRouter.post(
    '/test/run-job',
    validate({
      body: z.object({
        name: z.string().min(1).max(60),
        now: z.string().datetime().optional(),
      }),
    }),
    handler(async (req, res) => {
      const { name, now } = req.body as { name: string; now?: string };
      if (!isRunnableJob(name)) throw new NotFoundError('That job');

      const result = await runJob(name, now ? new Date(now) : new Date());
      res.json({ name, result });
    }),
  );
}

/**
 * Sends a test email to the caller.
 *
 * The point is to find out, before inviting anybody, whether SPF and DKIM are
 * right. It goes to the caller's own address and nowhere else, so it cannot be
 * used to send mail to strangers.
 */
orgRouter.post(
  '/test-email',
  requireRole('SUPER_ADMIN'),
  handler(async (req, res) => {
    const actor = requireActor(req);

    const [person] = await db
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, actor.id))
      .limit(1);

    if (!person) throw new NotFoundError('Your account');

    const { emailLayout, sendMail } = await import('../notifications/mailer');
    const settings = await getOrgSettings();

    try {
      await sendMail({
        to: person.email,
        subject: 'Task Manager test email',
        text: [
          'This is a test from your Task Manager deployment.',
          '',
          'If it reached your inbox rather than spam, check the headers show',
          'spf=pass and dkim=pass before inviting anybody.',
          '',
          'Sent at ' + new Date().toISOString() + ' (' + settings.timezone + ')',
        ].join('\n'),
        html: emailLayout(
          'Test email',
          '<p>This is a test from your Task Manager deployment.</p>' +
            '<p>If it reached your inbox rather than spam, check the headers show ' +
            '<code>spf=pass</code> and <code>dkim=pass</code> before inviting anybody.</p>',
        ),
      });
    } catch (error) {
      // The operator needs the reason, not a generic failure.
      throw new ValidationError(
        'The message could not be sent: ' +
          (error instanceof Error ? error.message : 'unknown error'),
      );
    }

    await recordAudit({ actor, action: 'email.test_sent', subjectType: 'org_settings', req });

    res.json({ sent: true, to: person.email });
  }),
);

/** The audit log itself. Admin only, because it records who granted what. */
orgRouter.get(
  '/audit',
  requireRole('SUPER_ADMIN'),
  validate({ query: listAuditQuerySchema }),
  handler(async (req, res) => {
    const query = req.query as unknown as ListAuditQuery;
    res.json(
      await listAudit(requireActor(req), {
        ...(query.limit ? { limit: query.limit } : {}),
        ...(query.action ? { action: query.action } : {}),
        ...(query.actorId ? { actorId: query.actorId } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
      }),
    );
  }),
);

/*
 * Holidays.
 *
 * Reading is open to anyone signed in, because the calendar and the due-date
 * pickers show which days are not working days. Changing them is the admin's,
 * since every working-day calculation in the system moves with them.
 */
orgRouter.get(
  '/holidays',
  validate({ query: z.object({ year: z.coerce.number().int().min(1970).max(2200).optional() }) }),
  handler(async (req, res) => {
    const { year } = req.query as unknown as { year?: number };
    res.json({ items: await listHolidays(year) });
  }),
);

orgRouter.post(
  '/holidays',
  requireRole('SUPER_ADMIN'),
  validate({ body: createHolidaySchema }),
  handler(async (req, res) => {
    const result = await addHolidays(requireActor(req), [req.body as CreateHolidayInput]);
    res.status(201).json(result);
  }),
);

/** A whole year at a time, pasted or from a CSV. */
orgRouter.post(
  '/holidays/bulk',
  requireRole('SUPER_ADMIN'),
  validate({ body: bulkHolidaysSchema }),
  handler(async (req, res) => {
    const { items } = req.body as BulkHolidaysInput;
    res.status(201).json(await addHolidays(requireActor(req), items));
  }),
);

orgRouter.delete(
  '/holidays/:date',
  requireRole('SUPER_ADMIN'),
  validate({ params: z.object({ date: dateOnlySchema }) }),
  handler(async (req, res) => {
    await removeHoliday(requireActor(req), req.params.date as string);
    res.status(204).send();
  }),
);
