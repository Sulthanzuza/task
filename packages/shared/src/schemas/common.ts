import { z } from 'zod';

export const uuidSchema = z.string().uuid('Must be a valid id');

export const idParamSchema = z.object({ id: uuidSchema });

/** ERP-125 style task key. */
export const TASK_KEY_PATTERN = /^[A-Z]{2,10}-\d+$/;
export const taskKeySchema = z.string().regex(TASK_KEY_PATTERN, 'Must look like ERP-125');

/** A task route accepts either a uuid or a task key. */
export const taskRefSchema = z.union([uuidSchema, taskKeySchema]);

export const projectKeySchema = z
  .string()
  .regex(/^[A-Z]{2,10}$/, 'Two to ten capital letters, for example ERP');

/** ISO calendar date, no time. Business dates use the org time zone, never the browser's. */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date like 2026-09-28');

export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 25;

export const cursorPaginationSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
});
export type CursorPagination = z.infer<typeof cursorPaginationSchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Accepts ?status=A&status=B and ?status=A,B alike. */
export function csvArray<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    const parts = Array.isArray(value) ? value : String(value).split(',');
    return parts.map((p) => (typeof p === 'string' ? p.trim() : p)).filter((p) => p !== '');
  }, z.array(item).optional());
}

export const booleanQuerySchema = z.preprocess((value) => {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return value;
}, z.boolean().optional());

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  TASK_CHANGED: 'TASK_CHANGED',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
