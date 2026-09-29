import { Router } from 'express';
import multer from 'multer';
import { authenticate, requireActor, requireRole } from '../../middleware/authenticate';
import { handler } from '../../middleware/validate';
import { ValidationError } from '../../lib/errors';
import { uploadLimiter } from '../../middleware/rateLimit';
import { commitImport, readRows, validateRows, IMPORT_COLUMNS } from './service';

export const importRouter: Router = Router();

importRouter.use(authenticate);
importRouter.use(requireRole('SUPER_ADMIN', 'TEAM_LEAD'));

/** Spreadsheets are small; 5 MB is far more than a task list needs. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

importRouter.get(
  '/columns',
  handler(async (_req, res) => {
    res.json({ columns: IMPORT_COLUMNS });
  }),
);

/**
 * The dry run. Reads the file, reports what would happen, writes nothing.
 * The operator sees every problem, with its row and column, before deciding.
 */
importRouter.post(
  '/preview',
  uploadLimiter,
  upload.single('file'),
  handler(async (req, res) => {
    const file = req.file;
    if (!file) throw new ValidationError('No file was uploaded.');

    const grid = await readRows({ fileName: file.originalname, buffer: file.buffer });
    res.json(await validateRows(requireActor(req), grid));
  }),
);

/**
 * The real thing. Re-reads and re-validates the file rather than trusting a
 * preview the client sends back: the preview is advice, not authorisation.
 *
 * Refuses the whole file if any row is wrong, so the operator never has to
 * work out which half of their spreadsheet arrived.
 */
importRouter.post(
  '/commit',
  uploadLimiter,
  upload.single('file'),
  handler(async (req, res) => {
    const file = req.file;
    if (!file) throw new ValidationError('No file was uploaded.');

    const actor = requireActor(req);
    const grid = await readRows({ fileName: file.originalname, buffer: file.buffer });
    const preview = await validateRows(actor, grid);

    res.status(201).json(await commitImport(actor, preview));
  }),
);
