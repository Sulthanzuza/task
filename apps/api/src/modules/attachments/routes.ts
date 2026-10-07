import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import multer from 'multer';
import { and, desc, eq } from 'drizzle-orm';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  idParamSchema,
  uploadAttachmentBodySchema,
  uuidSchema,
} from '@tm/shared';
import { z } from 'zod';
import { env } from '../../config/env';
import { db, withTransaction } from '../../db/client';
import { taskAttachments } from '../../db/schema';
import {
  NotFoundError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../lib/errors';
import { verifyUpload } from '../../lib/fileType';
import { getStorage } from '../../lib/storage';
import { authenticate, requireActor } from '../../middleware/authenticate';
import { uploadLimiter } from '../../middleware/rateLimit';
import { handler, validate } from '../../middleware/validate';
import { authorize } from '../permissions/authorize';
import { eventBase, loadTaskOr404, toResource } from '../tasks/service';
import * as taskRepo from '../tasks/repo';
import { EventBuffer } from '../../lib/events';

/**
 * Two routers, because the routes live under two prefixes.
 *
 * Mounting one router at '/' instead would authenticate every unmatched path
 * in the whole API, turning a 404 into a 401 and running the auth middleware
 * twice for everything that followed.
 */
export const taskAttachmentsRouter: Router = Router();
export const attachmentsRouter: Router = Router();

taskAttachmentsRouter.use(authenticate);
attachmentsRouter.use(authenticate);

/**
 * Files are held in memory while they are checked, then written once.
 * The limit is enforced here as well as by the reverse proxy, because the proxy
 * is not the only way a request can arrive.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 },
});

const refParam = z.object({ idOrKey: z.string().min(1).max(60) });

taskAttachmentsRouter.post(
  '/:idOrKey/attachments',
  uploadLimiter,
  validate({ params: refParam }),
  upload.single('file'),
  // After multer, because the text fields of a multipart body are not there
  // until it has read the stream.
  validate({ body: uploadAttachmentBodySchema }),
  handler(async (req, res) => {
    const actor = requireActor(req);
    const file = req.file;
    if (!file) throw new ValidationError('No file was uploaded.');
    const { description } = req.body as { description: string };

    const task = await loadTaskOr404(db, req.params.idOrKey as string);
    authorize(actor, 'task.attach', await toResource(db, task));

    if (file.size > env.MAX_UPLOAD_BYTES) {
      throw new PayloadTooLargeError('That file is larger than the limit.');
    }

    /*
     * The decisive check. The name and the declared Content-Type both come from
     * the uploader, so neither decides what this is: the first bytes do, and
     * the type that gets stored is the sniffed one.
     */
    const verdict = verifyUpload(file.buffer, file.mimetype, ALLOWED_ATTACHMENT_MIME_TYPES);
    if (!verdict.ok) {
      throw new UnsupportedMediaTypeError(verdict.reason ?? 'That file type is not allowed.');
    }

    const stored = await getStorage().put(file.buffer, {
      contentType: verdict.mime,
      fileName: file.originalname,
    });

    const uploadedAt = new Date();
    const buffer = new EventBuffer();

    const created = await withTransaction(async (tx) => {
      const [row] = await tx
        .insert(taskAttachments)
        .values({
          taskId: task.id,
          uploadedBy: actor.id,
          // Keep the name for display, but strip any path a client sent.
          fileName: file.originalname.replace(/^.*[\\/]/, '').slice(0, 255),
          description,
          mimeType: verdict.mime,
          sizeBytes: stored.sizeBytes,
          storageKey: stored.key,
        })
        .returning({ id: taskAttachments.id });

      if (!row) throw new Error('Attachment insert returned no row');

      await taskRepo.writeActivity(
        tx,
        [
          {
            taskId: task.id,
            actorId: actor.id,
            action: 'attachment.created',
            newValue: { fileName: file.originalname, description, mimeType: verdict.mime },
          },
        ],
        uploadedAt,
      );

      /*
       * Announced only once the transaction has committed, so a tab cannot be
       * told about a file that a rollback then took away.
       */
      buffer.add('attachment.created', {
        ...eventBase(task, actor, uploadedAt),
        attachmentId: row.id,
        fileName: file.originalname,
      });

      return row.id;
    });

    buffer.flush();

    res.status(201).json({
      id: created,
      fileName: file.originalname,
      description,
      mimeType: verdict.mime,
      sizeBytes: stored.sizeBytes,
      downloadUrl: '/api/v1/attachments/' + created,
    });
  }),
);

taskAttachmentsRouter.get(
  '/:idOrKey/attachments',
  validate({ params: refParam }),
  handler(async (req, res) => {
    const actor = requireActor(req);
    const task = await loadTaskOr404(db, req.params.idOrKey as string);
    authorize(actor, 'task.view', await toResource(db, task));

    const rows = await db
      .select()
      .from(taskAttachments)
      .where(eq(taskAttachments.taskId, task.id))
      .orderBy(desc(taskAttachments.createdAt));

    const people = await taskRepo.usersByIds(
      db,
      rows.map((r) => r.uploadedBy),
    );

    res.json({
      items: rows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        fileName: row.fileName,
        description: row.description,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        uploadedBy: {
          id: row.uploadedBy,
          name: people.get(row.uploadedBy)?.name ?? 'Unknown',
          avatarUrl: people.get(row.uploadedBy)?.avatarUrl ?? null,
        },
        downloadUrl: '/api/v1/attachments/' + row.id,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  }),
);

/** Streamed through the API, so the access check applies to the bytes too. */
attachmentsRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    const actor = requireActor(req);

    const [row] = await db
      .select()
      .from(taskAttachments)
      .where(eq(taskAttachments.id, req.params.id as string))
      .limit(1);

    if (!row) throw new NotFoundError('That attachment');

    const task = await taskRepo.findTaskById(db, row.taskId);
    if (!task) throw new NotFoundError('That task');
    authorize(actor, 'task.view', await toResource(db, task));

    const body = await getStorage().stream(row.storageKey);

    res.setHeader('Content-Type', row.mimeType);
    // Always a download. An uploaded SVG or HTML fragment must never be
    // rendered as a page on our own origin.
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="' + row.fileName.replace(/"/g, '') + '"',
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(row.sizeBytes));
    // pipeline destroys both ends on failure: a broken storage read ends the
    // response instead of leaving the download hanging, and a client that
    // goes away stops the read from storage.
    await pipeline(body, res);
  }),
);

attachmentsRouter.delete(
  '/:id',
  validate({ params: idParamSchema }),
  handler(async (req, res) => {
    const actor = requireActor(req);

    const [row] = await db
      .select()
      .from(taskAttachments)
      .where(eq(taskAttachments.id, req.params.id as string))
      .limit(1);

    if (!row) throw new NotFoundError('That attachment');

    const task = await taskRepo.findTaskById(db, row.taskId);
    if (!task) throw new NotFoundError('That task');

    const resource = await toResource(db, task);
    // Deleting someone else's upload is a lead's decision, like a comment.
    authorize(actor, 'comment.delete', {
      kind: 'comment',
      authorId: row.uploadedBy,
      createdAt: row.createdAt,
      task: resource,
    });

    const removedAt = new Date();
    const buffer = new EventBuffer();

    await withTransaction(async (tx) => {
      await tx
        .delete(taskAttachments)
        .where(and(eq(taskAttachments.id, row.id), eq(taskAttachments.taskId, row.taskId)));

      await taskRepo.writeActivity(
        tx,
        [
          {
            taskId: row.taskId,
            actorId: actor.id,
            action: 'attachment.deleted',
            oldValue: { fileName: row.fileName, description: row.description },
          },
        ],
        removedAt,
      );

      buffer.add('attachment.deleted', {
        ...eventBase(task, actor, removedAt),
        attachmentId: row.id,
        fileName: row.fileName,
      });
    });

    buffer.flush();

    // Only after the row is gone: an orphaned object is tidier than a row
    // pointing at nothing.
    await getStorage().remove(row.storageKey);

    res.status(204).send();
  }),
);

export { uuidSchema };
