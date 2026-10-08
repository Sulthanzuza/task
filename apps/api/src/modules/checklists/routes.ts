import { Router } from 'express';
import { z } from 'zod';
import {
  addChecklistItemSchema,
  createChecklistSchema,
  idParamSchema,
  renameChecklistSchema,
  reorderSchema,
  setProgressFollowsChecklistSchema,
  updateChecklistItemSchema,
} from '@tm/shared';
import { authenticate, requireActor } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import * as service from './service';

/**
 * Checklists hang off a task, and items off a checklist.
 *
 * Two routers: the task-scoped half mounts under /tasks/:idOrKey, and the
 * rest take an id of their own, because an item does not need its task named
 * again to be ticked.
 */

const refParam = z.object({ idOrKey: z.string().min(1).max(60) });

/** Mounted at /tasks/:idOrKey/checklists. */
export const taskChecklistsRouter: Router = Router({ mergeParams: true });
taskChecklistsRouter.use(authenticate);

taskChecklistsRouter.get(
  '/',
  validate({ params: refParam }),
  handler(async (req, res) => {
    res.json(await service.listChecklists(requireActor(req), req.params.idOrKey as string));
  }),
);

taskChecklistsRouter.post(
  '/',
  validate({ params: refParam, body: createChecklistSchema }),
  handler(async (req, res) => {
    const created = await service.addChecklist(
      requireActor(req),
      req.params.idOrKey as string,
      req.body as { title: string; items: string[] },
    );
    res.status(201).json(created);
  }),
);

taskChecklistsRouter.patch(
  '/order',
  validate({ params: refParam, body: reorderSchema }),
  handler(async (req, res) => {
    await service.reorderChecklists(
      requireActor(req),
      req.params.idOrKey as string,
      (req.body as { ids: string[] }).ids,
    );
    res.status(204).send();
  }),
);

taskChecklistsRouter.patch(
  '/progress-source',
  validate({ params: refParam, body: setProgressFollowsChecklistSchema }),
  handler(async (req, res) => {
    await service.setProgressFollowsChecklist(
      requireActor(req),
      req.params.idOrKey as string,
      (req.body as { enabled: boolean }).enabled,
    );
    res.status(204).send();
  }),
);

/** Mounted at /checklists. */
export const checklistsRouter: Router = Router();
checklistsRouter.use(authenticate);

checklistsRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: renameChecklistSchema }),
  handler(async (req, res) => {
    await service.renameChecklist(
      requireActor(req),
      req.params.id as string,
      (req.body as { title: string }).title,
    );
    res.status(204).send();
  }),
);

checklistsRouter.delete(
  '/:id',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    await service.deleteChecklist(requireActor(req), req.params.id as string);
    res.status(204).send();
  }),
);

checklistsRouter.post(
  '/:id/items',
  validate({ params: idParamSchema, body: addChecklistItemSchema }),
  handler(async (req, res) => {
    const created = await service.addItem(
      requireActor(req),
      req.params.id as string,
      (req.body as { text: string }).text,
    );
    res.status(201).json(created);
  }),
);

checklistsRouter.patch(
  '/:id/items/order',
  validate({ params: idParamSchema, body: reorderSchema }),
  handler(async (req, res) => {
    await service.reorderItems(
      requireActor(req),
      req.params.id as string,
      (req.body as { ids: string[] }).ids,
    );
    res.status(204).send();
  }),
);

/** Mounted at /checklist-items. */
export const checklistItemsRouter: Router = Router();
checklistItemsRouter.use(authenticate);

checklistItemsRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateChecklistItemSchema }),
  handler(async (req, res) => {
    await service.updateItem(
      requireActor(req),
      req.params.id as string,
      req.body as { text?: string; isDone?: boolean },
    );
    res.status(204).send();
  }),
);

checklistItemsRouter.delete(
  '/:id',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    await service.deleteItem(requireActor(req), req.params.id as string);
    res.status(204).send();
  }),
);
