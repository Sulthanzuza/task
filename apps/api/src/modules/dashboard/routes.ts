import { Router } from 'express';
import { z } from 'zod';
import { dashboardQuerySchema, idParamSchema } from '@tm/shared';
import { authenticate, requireActor } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import * as service from './service';

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
    res.json({ items: await service.getAttention(requireActor(req), teamId, new Date(), limit) });
  }),
);

/** A member's own page shows exactly the same numbers their lead sees. */
export const membersRouter: Router = Router();
membersRouter.use(authenticate);

membersRouter.get(
  '/:id/stats',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    res.json(await service.getMemberStats(requireActor(req), req.params.id as string));
  }),
);
