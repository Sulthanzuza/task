import { Router } from 'express';
import {
  createUserSchema,
  idParamSchema,
  listUsersQuerySchema,
  updateUserSchema,
} from '@tm/shared';
import { authenticate, requireActor, requireRole } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import * as service from './service';

export const usersRouter: Router = Router();

usersRouter.use(authenticate);

usersRouter.get(
  '/',
  validate({ query: listUsersQuerySchema }),
  handler(async (req, res) => {
    res.json(await service.listUsers(requireActor(req), req.query as never));
  }),
);

usersRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    res.json(await service.getUser(requireActor(req), req.params.id as string));
  }),
);

usersRouter.post(
  '/',
  requireRole('SUPER_ADMIN'),
  validate({ body: createUserSchema }),
  handler(async (req, res) => {
    res.status(201).json(await service.createUser(requireActor(req), req.body));
  }),
);

usersRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateUserSchema }),
  handler(async (req, res) => {
    res.json(await service.updateUser(requireActor(req), req.params.id as string, req.body));
  }),
);

usersRouter.post(
  '/:id/deactivate',
  requireRole('SUPER_ADMIN'),
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    await service.deactivateUser(requireActor(req), req.params.id as string);
    res.status(204).send();
  }),
);

usersRouter.post(
  '/:id/activate',
  requireRole('SUPER_ADMIN'),
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    await service.reactivateUser(requireActor(req), req.params.id as string);
    res.status(204).send();
  }),
);
