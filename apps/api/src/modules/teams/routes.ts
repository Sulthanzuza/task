import { Router } from 'express';
import { z } from 'zod';
import { createTeamSchema, idParamSchema, teamMemberSchema, updateTeamSchema, uuidSchema } from '@tm/shared';
import { authenticate, requireActor, requireRole } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import * as service from './service';

export const teamsRouter: Router = Router();

teamsRouter.use(authenticate);

teamsRouter.get(
  '/',
  handler(async (req, res) => {
    res.json({ items: await service.listTeams(requireActor(req)) });
  }),
);

teamsRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    res.json(await service.getTeam(requireActor(req), req.params.id as string));
  }),
);

teamsRouter.post(
  '/',
  requireRole('SUPER_ADMIN'),
  validate({ body: createTeamSchema }),
  handler(async (req, res) => {
    res.status(201).json(await service.createTeam(requireActor(req), req.body));
  }),
);

teamsRouter.patch(
  '/:id',
  requireRole('SUPER_ADMIN'),
  validate({ params: idParamSchema, body: updateTeamSchema }),
  handler(async (req, res) => {
    res.json(await service.updateTeam(requireActor(req), req.params.id as string, req.body));
  }),
);

teamsRouter.post(
  '/:id/members',
  requireRole('SUPER_ADMIN'),
  validate({ params: idParamSchema, body: teamMemberSchema }),
  handler(async (req, res) => {
    res.json(await service.addMember(requireActor(req), req.params.id as string, req.body.userId));
  }),
);

teamsRouter.delete(
  '/:id/members/:userId',
  requireRole('SUPER_ADMIN'),
  validate({ params: z.object({ id: uuidSchema, userId: uuidSchema }) }),
  handler(async (req, res) => {
    res.json(
      await service.removeMember(requireActor(req), req.params.id as string, req.params.userId as string),
    );
  }),
);
