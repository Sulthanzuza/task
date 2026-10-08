import { z } from 'zod';
import { cursorPaginationSchema, uuidSchema } from './common';

/**
 * Mentions are stored inline in the comment body as @[Display Name](userId)
 * so the text stays readable and the ids survive a rename.
 */
export const MENTION_PATTERN = /@\[([^\]]{1,120})\]\(([0-9a-fA-F-]{36})\)/g;

export function parseMentions(body: string): Array<{ name: string; userId: string }> {
  const found = new Map<string, string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    const userId = match[2];
    if (name && userId) found.set(userId.toLowerCase(), name);
  }
  return [...found.entries()].map(([userId, name]) => ({ userId, name }));
}

/** Turns the storage form into something a plain-text channel (email, digest) can show. */
export function stripMentionMarkup(body: string): string {
  return body.replace(MENTION_PATTERN, (_all, name: string) => '@' + name);
}

export const createCommentSchema = z.object({
  body: z.string().trim().min(1, 'Write a comment').max(10_000),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = createCommentSchema;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

export const listCommentsQuerySchema = cursorPaginationSchema;

/**
 * Why a file is on the task.
 *
 * Required: a file called final-v3.xlsx says nothing about what it is for,
 * and the person who attached it is the only one who knows. Files attached
 * before this was asked for carry an empty string.
 */
export const ATTACHMENT_DESCRIPTION_MAX = 500;
export const attachmentDescriptionSchema = z
  .string({ required_error: 'Say what this file is for.' })
  .trim()
  .min(1, 'Say what this file is for.')
  .max(ATTACHMENT_DESCRIPTION_MAX, 'Keep it under ' + ATTACHMENT_DESCRIPTION_MAX + ' characters.');

/** The fields sent alongside the file in the multipart upload. */
export const uploadAttachmentBodySchema = z.object({
  description: attachmentDescriptionSchema,
  /*
   * Sent as a string because multipart carries no types. The client says so
   * when the image went through the markup editor on its way here.
   */
  edited: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => value === true || value === 'true'),
});
export type UploadAttachmentBody = z.infer<typeof uploadAttachmentBodySchema>;

export const attachmentSchema = z.object({
  id: uuidSchema,
  taskId: uuidSchema,
  fileName: z.string(),
  description: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  /** Marked up before it was uploaded. */
  edited: z.boolean(),
  uploadedBy: z.object({ id: uuidSchema, name: z.string(), avatarUrl: z.string().nullable() }),
  downloadUrl: z.string(),
  createdAt: z.string(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

/** Editing or deleting your own comment is allowed for this long after posting. */
export const COMMENT_SELF_EDIT_WINDOW_MINUTES = 15;

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'text/csv',
] as const;
