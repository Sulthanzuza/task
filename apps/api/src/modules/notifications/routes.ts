import { Router } from 'express';
import { z } from 'zod';
import { SOCKET_EVENTS, idParamSchema, notificationTypeSchema } from '@tm/shared';
import { authenticate, requireActor } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import { emitToUser } from '../../realtime/gateway';
import * as service from './service';

export const notificationsRouter: Router = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get(
  '/',
  validate({
    query: z.object({
      unreadOnly: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  }),
  handler(async (req, res) => {
    const { unreadOnly, limit } = req.query as unknown as {
      unreadOnly?: string;
      limit?: number;
    };
    res.json(
      await service.listNotifications(requireActor(req), {
        unreadOnly: unreadOnly === 'true',
        ...(limit ? { limit } : {}),
      }),
    );
  }),
);

/** Polled on reconnect, so a tab that missed events catches up cheaply. */
notificationsRouter.get(
  '/unread-count',
  handler(async (req, res) => {
    res.json({ unread: await service.unreadCount(requireActor(req)) });
  }),
);

notificationsRouter.post(
  '/:id/read',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    const actor = requireActor(req);
    const unread = await service.markRead(actor, req.params.id as string);

    // Every tab of this person's, so the bell agrees with itself.
    emitToUser(actor.id, SOCKET_EVENTS.notificationRead, {
      notificationId: req.params.id,
      unread,
    });

    res.json({ unread });
  }),
);

notificationsRouter.post(
  '/read-all',
  handler(async (req, res) => {
    const actor = requireActor(req);
    const unread = await service.markAllRead(actor);
    emitToUser(actor.id, SOCKET_EVENTS.notificationRead, { notificationId: null, unread });
    res.json({ unread });
  }),
);

notificationsRouter.get(
  '/preferences',
  handler(async (req, res) => {
    res.json({ items: await service.getPreferences(requireActor(req)) });
  }),
);

notificationsRouter.put(
  '/preferences/:type',
  validate({
    params: z.object({ type: notificationTypeSchema }),
    body: z.object({
      inApp: z.boolean().optional(),
      email: z.boolean().optional(),
      digestOnly: z.boolean().optional(),
    }),
  }),
  handler(async (req, res) => {
    res.json({
      items: await service.setPreference(requireActor(req), req.params.type as string, req.body),
    });
  }),
);
