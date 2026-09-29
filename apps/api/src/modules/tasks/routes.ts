import { Router } from 'express';
import { z } from 'zod';
import {
  addDependencySchema,
  boardQuerySchema,
  assignTaskSchema,
  createCommentSchema,
  createTaskSchema,
  idParamSchema,
  listTasksQuerySchema,
  transitionTaskSchema,
  updateProgressSchema,
  updateTaskSchema,
  uuidSchema,
} from '@tm/shared';
import { authenticate, requireActor } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import * as service from './service';
import { addComment } from '../comments/service';

export const tasksRouter: Router = Router();

tasksRouter.use(authenticate);

const refParam = z.object({ idOrKey: z.string().min(1).max(60) });
const projectParam = z.object({ projectId: uuidSchema });

/** POST /api/v1/projects/:projectId/tasks */
export const projectTasksRouter: Router = Router({ mergeParams: true });
projectTasksRouter.use(authenticate);

projectTasksRouter.post(
  '/',
  validate({ params: projectParam, body: createTaskSchema }),
  handler(async (req, res) => {
    const task = await service.createTask(
      requireActor(req),
      (req.params as z.infer<typeof projectParam>).projectId,
      req.body,
    );
    res.status(201).json(task);
  }),
);

/** Registered before /:idOrKey so "board" is not read as a task key. */
tasksRouter.get(
  '/board',
  validate({ query: boardQuerySchema }),
  handler(async (req, res) => {
    const { projectId, teamId } = req.query as { projectId?: string; teamId?: string };
    res.json(await service.getBoardSummary(requireActor(req), { projectId, teamId }));
  }),
);

tasksRouter.get(
  '/',
  validate({ query: listTasksQuerySchema }),
  handler(async (req, res) => {
    const page = await service.listTasksForActor(
      requireActor(req),
      req.query as unknown as z.infer<typeof listTasksQuerySchema>,
    );
    res.json(page);
  }),
);

/** Accepts a uuid or a task key such as ERP-125. */
tasksRouter.get(
  '/:idOrKey',
  validate({ params: refParam }),
  handler(async (req, res) => {
    const task = await service.getTaskDetail(requireActor(req), req.params.idOrKey as string);
    res.json(task);
  }),
);

tasksRouter.get(
  '/:idOrKey/timeline',
  validate({ params: refParam }),
  handler(async (req, res) => {
    const timeline = await service.getTimeline(requireActor(req), req.params.idOrKey as string);
    res.json({ items: timeline });
  }),
);

tasksRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateTaskSchema }),
  handler(async (req, res) => {
    const task = await service.updateTask(requireActor(req), req.params.id as string, req.body);
    res.json(task);
  }),
);

/** The only route that changes a status. */
tasksRouter.post(
  '/:id/transition',
  validate({ params: idParamSchema, body: transitionTaskSchema }),
  handler(async (req, res) => {
    const task = await service.transitionTask(requireActor(req), req.params.id as string, req.body);
    res.json(task);
  }),
);

tasksRouter.post(
  '/:id/assign',
  validate({ params: idParamSchema, body: assignTaskSchema }),
  handler(async (req, res) => {
    const task = await service.assignTask(requireActor(req), req.params.id as string, req.body);
    res.json(task);
  }),
);

tasksRouter.put(
  '/:id/progress',
  validate({ params: idParamSchema, body: updateProgressSchema }),
  handler(async (req, res) => {
    const task = await service.updateProgress(
      requireActor(req),
      req.params.id as string,
      req.body.progress,
    );
    res.json(task);
  }),
);

tasksRouter.delete(
  '/:id',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    await service.softDeleteTask(requireActor(req), req.params.id as string);
    res.status(204).send();
  }),
);

tasksRouter.post(
  '/:id/watchers/me',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    await service.watchTask(requireActor(req), req.params.id as string);
    res.status(204).send();
  }),
);

tasksRouter.delete(
  '/:id/watchers/me',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    await service.unwatchTask(requireActor(req), req.params.id as string);
    res.status(204).send();
  }),
);

tasksRouter.post(
  '/:id/dependencies',
  validate({ params: idParamSchema, body: addDependencySchema }),
  handler(async (req, res) => {
    await service.addDependency(
      requireActor(req),
      req.params.id as string,
      req.body.dependsOnTaskId,
      req.body.type,
    );
    res.status(204).send();
  }),
);

tasksRouter.delete(
  '/:id/dependencies/:dependsOnTaskId',
  validate({ params: z.object({ id: uuidSchema, dependsOnTaskId: uuidSchema }) }),
  handler(async (req, res) => {
    await service.removeDependency(
      requireActor(req),
      req.params.id as string,
      req.params.dependsOnTaskId as string,
    );
    res.status(204).send();
  }),
);

tasksRouter.post(
  '/:idOrKey/comments',
  validate({ params: refParam, body: createCommentSchema }),
  handler(async (req, res) => {
    const comment = await addComment(
      requireActor(req),
      req.params.idOrKey as string,
      req.body.body,
    );
    res.status(201).json(comment);
  }),
);
