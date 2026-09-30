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

/**
 * Everything the dashboard's charts need, in one round trip.
 *
 * Six datasets rather than six requests: a dashboard that fires six calls
 * shows six different moments, and the numbers then disagree with each other
 * on screen.
 */

export const DASHBOARD_PERIODS = ['week', 'month', 'quarter'] as const;
export const dashboardPeriodSchema = z.enum(DASHBOARD_PERIODS);
export type DashboardPeriod = z.infer<typeof dashboardPeriodSchema>;

export const weeklyPointSchema = z.object({
  /** Monday of the week, in the organisation's time zone. */
  weekStart: dateOnlySchema,
  label: z.string(),
  created: z.number().int(),
  completed: z.number().int(),
  overdue: z.number().int(),
});
export type WeeklyPoint = z.infer<typeof weeklyPointSchema>;

export const countSliceSchema = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
});
export type CountSlice = z.infer<typeof countSliceSchema>;

export const projectProgressSchema = z.object({
  projectId: uuidSchema,
  key: z.string(),
  name: z.string(),
  done: z.number().int(),
  total: z.number().int(),
  open: z.number().int(),
  overdue: z.number().int(),
  dueThisWeek: z.number().int(),
});
export type ProjectProgress = z.infer<typeof projectProgressSchema>;

export const dueLoadCellSchema = z.object({
  userId: uuidSchema,
  date: dateOnlySchema,
  hours: z.number(),
  tasks: z.array(z.object({ key: z.string(), title: z.string(), hours: z.number() })),
});
export type DueLoadCell = z.infer<typeof dueLoadCellSchema>;

export const dueLoadDaySchema = z.object({
  date: dateOnlySchema,
  label: z.string(),
  weekday: z.string(),
  /** A weekend or a holiday: hatched, never shaded. */
  working: z.boolean(),
  /** Named when the day is a holiday, so the grid can say which one. */
  holiday: z.string().nullable(),
});
export type DueLoadDay = z.infer<typeof dueLoadDaySchema>;

export const dashboardChartsSchema = z.object({
  teamId: uuidSchema,
  period: dashboardPeriodSchema,
  asOfDate: dateOnlySchema,
  timezone: z.string(),
  /** How many trailing weekly bars belong to the chosen period. */
  highlightWeeks: z.number().int(),
  /**
   * Share of recently completed work that met its due date, 0 to 1, or null
   * when nothing finished had a due date. A fact about the work, counted the
   * same way the member page counts it; never a ranking of people.
   */
  onTimeRate: z.number().nullable(),
  /** Completed in the current and the previous week, for the change figure. */
  completedThisWeek: z.number().int(),
  completedLastWeek: z.number().int(),
  /**
   * The part of this week that has actually happened, against the same part of
   * last week. Comparing three days against seven makes every Wednesday look
   * like a collapse.
   */
  weekToDate: z.object({
    throughWeekday: z.string(),
    created: z.number().int(),
    completed: z.number().int(),
    createdLastWeek: z.number().int(),
    completedLastWeek: z.number().int(),
  }),
  /** Hours in a working day, for marking an overloaded cell. */
  workHoursPerDay: z.number(),
  weekly: z.array(weeklyPointSchema),
  statusBreakdown: z.array(countSliceSchema),
  priorityMix: z.array(countSliceSchema),
  labelMix: z.array(countSliceSchema),
  projects: z.array(projectProgressSchema),
  dueLoad: z.object({
    days: z.array(dueLoadDaySchema),
    people: z.array(userSummarySchema),
    cells: z.array(dueLoadCellSchema),
  }),
});
export type DashboardCharts = z.infer<typeof dashboardChartsSchema>;

export const dashboardChartsQuerySchema = z.object({
  teamId: uuidSchema.optional(),
  /** A month by default: a single week selects only the week still running. */
  period: dashboardPeriodSchema.default('month'),
});
export type DashboardChartsQuery = z.infer<typeof dashboardChartsQuerySchema>;
