import { Router } from 'express';
import { idParamSchema, updateCommentSchema } from '@tm/shared';
import { authenticate, requireActor } from '../../middleware/authenticate';
import { handler, validate } from '../../middleware/validate';
import * as service from './service';

export const commentsRouter: Router = Router();

commentsRouter.use(authenticate);

commentsRouter.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateCommentSchema }),
  handler(async (req, res) => {
    res.json(await service.editComment(requireActor(req), req.params.id as string, req.body.body));
  }),
);

commentsRouter.delete(
  '/:id',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    await service.deleteComment(requireActor(req), req.params.id as string);
    res.status(204).send();
  }),
);
