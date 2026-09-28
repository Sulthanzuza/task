import { z } from 'zod';
import { blockerTypeSchema, taskPrioritySchema, taskStatusSchema } from '../enums';
import { dateOnlySchema, uuidSchema } from './common';
import { userSummarySchema } from './user';

export const dashboardQuerySchema = z.object({
  teamId: uuidSchema.optional(),
  projectId: uuidSchema.optional(),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/** Every count here follows the definitions in the metric table; see metrics.ts. */
export const dashboardSummarySchema = z.object({
  active: z.number().int(),
  dueToday: z.number().int(),
  overdue: z.number().int(),
  blocked: z.number().int(),
  waitingReview: z.number().int(),
  completedThisWeek: z.number().int(),
  noUpdate: z.number().int(),
  unassignedOpen: z.number().int(),
  /** The org-timezone date the numbers were computed for. */
  asOfDate: dateOnlySchema,
  timezone: z.string(),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export const memberRowSchema = z.object({
  user: userSummarySchema,
  active: z.number().int(),
  overdue: z.number().int(),
  blocked: z.number().int(),
  waitingReview: z.number().int(),
  completedThisWeek: z.number().int(),
  lastActivityAt: z.string().nullable(),
});
export type MemberRow = z.infer<typeof memberRowSchema>;

export const ATTENTION_REASONS = [
  'OVERDUE',
  'DUE_TODAY_LOW_PROGRESS',
  'BLOCKED',
  'NO_UPDATE',
  'REVIEW_WAITING',
] as const;
export const attentionReasonSchema = z.enum(ATTENTION_REASONS);
export type AttentionReason = z.infer<typeof attentionReasonSchema>;

export const ATTENTION_REASON_LABELS: Record<AttentionReason, string> = {
  OVERDUE: 'Overdue',
  DUE_TODAY_LOW_PROGRESS: 'Due today, under half done',
  BLOCKED: 'Blocked',
  NO_UPDATE: 'No update',
  REVIEW_WAITING: 'Waiting for review',
};

export const attentionItemSchema = z.object({
  taskId: uuidSchema,
  key: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  progress: z.number().int(),
  dueDate: dateOnlySchema.nullable(),
  assignee: userSummarySchema.nullable(),
  reason: attentionReasonSchema,
  /** Working days overdue, or hours blocked / without an update, depending on the reason. */
  magnitude: z.number(),
  detail: z.string(),
  blockerType: blockerTypeSchema.nullable(),
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

export const memberStatsSchema = z.object({
  user: userSummarySchema,
  active: z.number().int(),
  overdue: z.number().int(),
  blocked: z.number().int(),
  waitingReview: z.number().int(),
  completedLast30Days: z.number().int(),
  medianCompletionHours: z.number().nullable(),
  onTimeRate: z.number().nullable(),
  lastActivityAt: z.string().nullable(),
});
export type MemberStats = z.infer<typeof memberStatsSchema>;
