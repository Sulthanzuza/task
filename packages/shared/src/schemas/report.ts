import { z } from 'zod';
import { dateOnlySchema, uuidSchema } from './common';
import { blockerTypeSchema } from '../enums';
import type { taskPrioritySchema } from '../enums';
import { userSummarySchema } from './user';

/**
 * The Reports page: facts per metric, over a range somebody chose.
 *
 * Every number here is a count or a median of real rows, and every one of
 * them drills down to the task list that produced it. There are deliberately
 * no scores and no rankings: the product shows what happened and leaves the
 * judgement to the person reading it, which is also why the People table is
 * sorted by name and not by any of its numbers.
 */

/**
 * The ranges worth one click.
 *
 * All of them are resolved on the server, because only it knows the
 * organisation's time zone and which day its week starts on. A browser
 * computing "this week" from its own clock would disagree with every other
 * number on the page.
 */
export const REPORT_PRESETS = [
  'thisWeek',
  'last4Weeks',
  'thisMonth',
  'lastQuarter',
  'custom',
] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export const REPORT_PRESET_LABELS: Record<ReportPreset, string> = {
  thisWeek: 'This week',
  last4Weeks: 'Last 4 weeks',
  thisMonth: 'This month',
  lastQuarter: 'Last quarter',
  custom: 'Custom',
};

export const reportQuerySchema = z
  .object({
    preset: z.enum(REPORT_PRESETS).default('last4Weeks'),
    /** Required when the preset is custom; ignored otherwise. */
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    teamId: uuidSchema.optional(),
    projectId: uuidSchema.optional(),
    assigneeId: uuidSchema.optional(),
    labelId: uuidSchema.optional(),
  })
  .refine((v) => v.preset !== 'custom' || (!!v.from && !!v.to), {
    message: 'A custom range needs both dates',
    path: ['from'],
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: 'The start date must be on or before the end date',
    path: ['to'],
  });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

/**
 * A number, and the same number over the previous window of equal length.
 *
 * The comparison is what makes a count mean anything: 23 completed is not
 * information until you know last month was 15. `previous` is null where
 * there is no earlier data to compare against, rather than zero, which would
 * read as a collapse.
 */
export const reportMetricSchema = z.object({
  value: z.number(),
  previous: z.number().nullable(),
  /** The query string that opens the task list behind this number. */
  drilldown: z.string().nullable(),
});
export type ReportMetric = z.infer<typeof reportMetricSchema>;

export const reportSummarySchema = z.object({
  created: reportMetricSchema,
  completed: reportMetricSchema,
  /** Completed on or before the due date, over those that had one. */
  onTimeRate: reportMetricSchema.nullable(),
  /** Working hours from first In progress to Completed. */
  medianCycleHours: reportMetricSchema.nullable(),
  /** As things stand now, not over the range: an overdue task is overdue today. */
  overdueNow: reportMetricSchema,
  blockedNow: reportMetricSchema,
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

export const weekPointSchema = z.object({
  weekStart: dateOnlySchema,
  label: z.string(),
  created: z.number().int(),
  completed: z.number().int(),
});
export type WeekPoint = z.infer<typeof weekPointSchema>;

export const overduePointSchema = z.object({
  date: dateOnlySchema,
  overdue: z.number().int(),
  /**
   * Whether this day was written down by the nightly job or rebuilt from the
   * activity log. A rebuilt day is an estimate, and the chart says so rather
   * than presenting both as equally solid.
   */
  estimated: z.boolean(),
});
export type OverduePoint = z.infer<typeof overduePointSchema>;

export const cycleTimePointSchema = z.object({
  key: z.string(),
  label: z.string(),
  medianHours: z.number().nullable(),
  p75Hours: z.number().nullable(),
  completed: z.number().int(),
});
export type CycleTimePoint = z.infer<typeof cycleTimePointSchema>;

export const blockedByTypeSchema = z.object({
  blockerType: blockerTypeSchema,
  label: z.string(),
  hours: z.number(),
  spells: z.number().int(),
});
export type BlockedByType = z.infer<typeof blockedByTypeSchema>;

export const blockedTaskSchema = z.object({
  taskId: uuidSchema,
  key: z.string(),
  title: z.string(),
  blockerType: blockerTypeSchema.nullable(),
  hours: z.number(),
  /** Still blocked right now, as opposed to a spell that has ended. */
  current: z.boolean(),
  assignee: userSummarySchema.nullable(),
});
export type BlockedTask = z.infer<typeof blockedTaskSchema>;

export const reportPersonSchema = z.object({
  user: userSummarySchema,
  completed: z.number().int(),
  onTimeRate: z.number().nullable(),
  medianCycleHours: z.number().nullable(),
  openNow: z.number().int(),
  overdueNow: z.number().int(),
});
export type ReportPerson = z.infer<typeof reportPersonSchema>;

export const reportProjectSchema = z.object({
  projectId: uuidSchema,
  key: z.string(),
  name: z.string(),
  openNow: z.number().int(),
  completed: z.number().int(),
  overdueNow: z.number().int(),
  onTimeRate: z.number().nullable(),
  /** Completed over all tasks ever in the project, not over the range. */
  percentDone: z.number(),
});
export type ReportProject = z.infer<typeof reportProjectSchema>;

/** Everything the page draws, in one round trip. */
export const reportSchema = z.object({
  /** The range the server actually used, after resolving the preset. */
  range: z.object({
    from: dateOnlySchema,
    to: dateOnlySchema,
    previousFrom: dateOnlySchema,
    previousTo: dateOnlySchema,
    timezone: z.string(),
    label: z.string(),
  }),
  summary: reportSummarySchema,
  throughput: z.array(weekPointSchema),
  overdueTrend: z.array(overduePointSchema),
  cycleByWeek: z.array(cycleTimePointSchema),
  cycleByLabel: z.array(cycleTimePointSchema),
  cycleByPriority: z.array(cycleTimePointSchema),
  blockedByType: z.array(blockedByTypeSchema),
  longestBlocked: z.array(blockedTaskSchema),
  people: z.array(reportPersonSchema),
  projects: z.array(reportProjectSchema),
});
export type Report = z.infer<typeof reportSchema>;

/** Which sections the export writes, one sheet each in XLSX. */
export const REPORT_SHEETS = [
  'Filters',
  'Summary',
  'Throughput',
  'Overdue trend',
  'Cycle time',
  'Blocked time',
  'People',
  'Projects',
] as const;
export type ReportSheet = (typeof REPORT_SHEETS)[number];

export const reportExportQuerySchema = reportQuerySchema.and(
  z.object({ format: z.enum(['csv', 'xlsx']).default('csv') }),
);
export type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;

/** Priority order for the cycle-time breakdown: severity, not alphabet. */
export const REPORT_PRIORITY_ORDER = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'] as const;

export type ReportPriority = z.infer<typeof taskPrioritySchema>;
