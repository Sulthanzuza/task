import { z } from 'zod';
import { uuidSchema } from './common';
import { userSummarySchema } from './user';

/**
 * Checklists on a task.
 *
 * Several per task, each with a title, because one flat list of twenty items
 * is not how work is grouped: "Build", "Test" and "Deploy" each have their
 * own steps and their own sense of being finished. A task with one list is
 * the ordinary case and is simply a task with one checklist.
 */

export const CHECKLIST_TITLE_MAX = 120;
export const CHECKLIST_ITEM_MAX = 500;

export const checklistTitleSchema = z
  .string({ required_error: 'Give the checklist a name.' })
  .trim()
  .min(1, 'Give the checklist a name.')
  .max(CHECKLIST_TITLE_MAX, 'Keep the name under ' + CHECKLIST_TITLE_MAX + ' characters.');

export const checklistItemTextSchema = z
  .string({ required_error: 'Say what the step is.' })
  .trim()
  .min(1, 'Say what the step is.')
  .max(CHECKLIST_ITEM_MAX, 'Keep a step under ' + CHECKLIST_ITEM_MAX + ' characters.');

export const checklistItemSchema = z.object({
  id: uuidSchema,
  checklistId: uuidSchema,
  text: z.string(),
  isDone: z.boolean(),
  position: z.number().int(),
  doneBy: userSummarySchema.nullable(),
  doneAt: z.string().nullable(),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const checklistSchema = z.object({
  id: uuidSchema,
  taskId: uuidSchema,
  title: z.string(),
  position: z.number().int(),
  items: z.array(checklistItemSchema),
  /** Counted on the server, so "3/7" and the bar agree with the items. */
  doneCount: z.number().int(),
  totalCount: z.number().int(),
});
export type Checklist = z.infer<typeof checklistSchema>;

export const checklistsResponseSchema = z.object({
  items: z.array(checklistSchema),
  /** Across every checklist on the task, which is what progress follows. */
  doneCount: z.number().int(),
  totalCount: z.number().int(),
  progressFollowsChecklist: z.boolean(),
});
export type ChecklistsResponse = z.infer<typeof checklistsResponseSchema>;

/** A checklist and its first items, as the create drawer sends them. */
export const checklistDraftSchema = z.object({
  title: checklistTitleSchema,
  items: z.array(checklistItemTextSchema).max(100, 'That is a lot of steps for one list.'),
});
export type ChecklistDraft = z.infer<typeof checklistDraftSchema>;

export const createChecklistSchema = checklistDraftSchema;

export const renameChecklistSchema = z.object({ title: checklistTitleSchema });

export const addChecklistItemSchema = z.object({ text: checklistItemTextSchema });

export const updateChecklistItemSchema = z.object({
  text: checklistItemTextSchema.optional(),
  isDone: z.boolean().optional(),
});

/** Reordering sends the whole order, so there is no ambiguity about the result. */
export const reorderSchema = z.object({ ids: z.array(uuidSchema).min(1) });

export const setProgressFollowsChecklistSchema = z.object({ enabled: z.boolean() });

/**
 * Progress from the ticks: ticked items over all items, across every checklist
 * on the task.
 *
 * A task with checklists but no items is 0 rather than 100: an empty list is
 * work not yet broken down, not work finished. Rounded, because progress is a
 * whole-number percentage everywhere else in the product.
 */
export function progressFromChecklists(doneCount: number, totalCount: number): number {
  if (totalCount <= 0) return 0;
  return Math.round((doneCount / totalCount) * 100);
}
