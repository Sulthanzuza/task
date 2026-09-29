import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { dateOnlySchema, uuidSchema } from '@tm/shared';
import { isTest } from '../../config/env';
import { db } from '../../db/client';
import { orgSettings } from '../../db/schema';
import { ForbiddenError, NotFoundError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { authenticate, requireActor, requireRole } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import { authorize } from '../permissions/authorize';
import { buildDigest } from '../alerts/digest';
import { clearOrgCache, getOrgSettings } from './service';
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

const updateSettingsSchema = z
  .object({
    timezone: z.string().min(1).max(64).optional(),
    weekendDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    weekStartsOn: z.number().int().min(0).max(6).optional(),
    workHoursPerDay: z.number().min(1).max(24).optional(),
    noUpdateThresholdHours: z.number().int().min(1).max(336).optional(),
    blockedEscalationHours: z.number().int().min(1).max(336).optional(),
    reviewWaitingThresholdHours: z.number().int().min(1).max(336).optional(),
    overdueEscalationWorkingDays: z.number().int().min(1).max(30).optional(),
    digestTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
    quietHoursStart: z.number().int().min(0).max(23).optional(),
    quietHoursEnd: z.number().int().min(0).max(23).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

orgRouter.patch(
  '/settings',
  requireRole('SUPER_ADMIN'),
  validate({ body: updateSettingsSchema }),
  handler(async (req, res) => {
    const input = req.body as z.infer<typeof updateSettingsSchema>;
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
 * Refused outside the test environment. A route that can make the system think
 * it is a different day has no business existing in production, however well
 * guarded by a role.
 */
orgRouter.post(
  '/test/run-job',
  validate({
    body: z.object({
      name: z.string().min(1).max(60),
      now: z.string().datetime().optional(),
    }),
  }),
  handler(async (req, res) => {
    if (!isTest) throw new ForbiddenError('This endpoint only exists in the test environment.');

    const { name, now } = req.body as { name: string; now?: string };
    if (!isRunnableJob(name)) throw new NotFoundError('That job');

    const result = await runJob(name, now ? new Date(now) : new Date());
    res.json({ name, result });
  }),
);
