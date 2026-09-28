import { Router } from 'express';
import { z } from 'zod';
import {
  createLabelSchema,
  createProjectSchema,
  idParamSchema,
  listProjectsQuerySchema,
  updateProjectSchema,
  uuidSchema,
} from '@tm/shared';
import { authenticate, requireActor } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import * as service from './service';

export const projectsRouter: Router = Router();

projectsRouter.use(authenticate);

projectsRouter.get(
  '/',
  validate({ query: listProjectsQuerySchema }),
  handler(async (req, res) => {
    res.json(await service.listProjects(requireActor(req), req.query as never));
  }),
);

projectsRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    res.json(await service.getProject(requireActor(req), req.params.id as string));
  }),
);

projectsRouter.post(
  '/',
  validate({ body: createProjectSchema }),
  handler(async (req, res) => {
    res.status(201).json(await service.createProject(requireActor(req), req.body));
  }),
);

projectsRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateProjectSchema }),
  handler(async (req, res) => {
    res.json(await service.updateProject(requireActor(req), req.params.id as string, req.body));
  }),
);

/** Archive, or restore an already archived project. */
projectsRouter.post(
  '/:id/archive',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    res.json(await service.archiveProject(requireActor(req), req.params.id as string));
  }),
);

projectsRouter.get(
  '/:id/labels',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    res.json(await service.listLabels(requireActor(req), req.params.id as string));
  }),
);

export const labelsRouter: Router = Router();
labelsRouter.use(authenticate);

labelsRouter.get(
  '/',
  validate({ query: z.object({ projectId: uuidSchema.optional() }) }),
  handler(async (req, res) => {
    const { projectId } = req.query as { projectId?: string };
    res.json(await service.listLabels(requireActor(req), projectId));
  }),
);

labelsRouter.post(
  '/',
  validate({ body: createLabelSchema }),
  handler(async (req, res) => {
    res.status(201).json(await service.createLabel(requireActor(req), req.body));
  }),
);
