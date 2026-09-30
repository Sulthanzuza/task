import { Router } from 'express';
import { z } from 'zod';
import { dashboardChartsQuerySchema, dashboardQuerySchema, idParamSchema } from '@tm/shared';
import type { DashboardChartsQuery } from '@tm/shared';
import { authenticate, requireActor } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import * as service from './service';
import { getCharts } from './charts';

export const dashboardRouter: Router = Router();

dashboardRouter.use(authenticate);

dashboardRouter.get(
  '/summary',
  validate({ query: dashboardQuerySchema }),
  handler(async (req, res) => {
    const { teamId } = req.query as { teamId?: string };
    res.json(await service.getSummary(requireActor(req), teamId));
  }),
);

/**
 * Everything the charts need, in one round trip.
 *
 * Six separate calls would show six different moments and the numbers would
 * disagree with each other on screen.
 */
dashboardRouter.get(
  '/charts',
  validate({ query: dashboardChartsQuerySchema }),
  handler(async (req, res) => {
    const { teamId, period } = req.query as unknown as DashboardChartsQuery;
    res.json(await getCharts(requireActor(req), teamId, period));
  }),
);

dashboardRouter.get(
  '/members',
  validate({ query: dashboardQuerySchema }),
  handler(async (req, res) => {
    const { teamId } = req.query as { teamId?: string };
    res.json({ items: await service.getMemberRows(requireActor(req), teamId) });
  }),
);

dashboardRouter.get(
  '/attention',
  validate({
    query: dashboardQuerySchema.extend({
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
  }),
  handler(async (req, res) => {
    const { teamId, limit } = req.query as unknown as { teamId?: string; limit: number };
    res.json(await service.getAttention(requireActor(req), teamId, new Date(), limit));
  }),
);

/** A member's own page shows exactly the same numbers their lead sees. */
export const membersRouter: Router = Router();
membersRouter.use(authenticate);

/** The last things this person did, for their member page. */
membersRouter.get(
  '/:id/activity',
  validate({
    params: idParamSchema,
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
  }),
  handler(async (req, res) => {
    const { limit } = req.query as unknown as { limit?: number };
    res.json({
      items: await service.getMemberActivity(requireActor(req), req.params.id as string, limit),
    });
  }),
);

membersRouter.get(
  '/:id/stats',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    res.json(await service.getMemberStats(requireActor(req), req.params.id as string));
  }),
);
