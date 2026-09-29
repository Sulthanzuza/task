import { z } from 'zod';
import {
  blockerTypeSchema,
  dependencyTypeSchema,
  taskPrioritySchema,
  taskStatusSchema,
} from '../enums';
import {
  booleanQuerySchema,
  csvArray,
  cursorPaginationSchema,
  dateOnlySchema,
  uuidSchema,
} from './common';
import { labelSchema } from './project';
import { userSummarySchema } from './user';

export const progressSchema = z.coerce.number().int().min(0).max(100);

/** Hours in the form, minutes in the database. */
export const estimatedHoursSchema = z.coerce.number().min(0).max(1000).nullable().optional();

export const taskSummarySchema = z.object({
  id: uuidSchema,
  key: z.string(),
  number: z.number().int(),
  projectId: uuidSchema,
  projectKey: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  progress: z.number().int(),
  assignee: userSummarySchema.nullable(),
  reviewer: userSummarySchema.nullable(),
  startDate: dateOnlySchema.nullable(),
  dueDate: dateOnlySchema.nullable(),
  estimatedMinutes: z.number().int().nullable(),
  blockedReason: z.string().nullable(),
  blockerType: blockerTypeSchema.nullable(),
  blockedAt: z.string().nullable(),
  lastActivityAt: z.string(),
  completedAt: z.string().nullable(),
  parentTaskId: uuidSchema.nullable(),
  labels: z.array(labelSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const taskDependencySchema = z.object({
  taskId: uuidSchema,
  key: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  type: dependencyTypeSchema,
});
export type TaskDependency = z.infer<typeof taskDependencySchema>;

export const taskDetailSchema = taskSummarySchema.extend({
  description: z.string().nullable(),
  createdBy: userSummarySchema,
  watcherIds: z.array(uuidSchema),
  subtaskCount: z.object({ total: z.number().int(), done: z.number().int() }),
  dependsOn: z.array(taskDependencySchema),
  blocks: z.array(taskDependencySchema),
  /** What this user may do next, straight from the workflow table. */
  availableTransitions: z.array(
    z.object({
      to: taskStatusSchema,
      label: z.string(),
      requires: z.array(z.enum(['comment', 'blockedReason'])),
    }),
  ),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(3, 'Give the task a title').max(300),
    description: z.string().trim().max(50_000).optional(),
    assigneeId: uuidSchema.nullable().optional(),
    reviewerId: uuidSchema.nullable().optional(),
    priority: taskPrioritySchema.default('MEDIUM'),
    startDate: dateOnlySchema.nullable().optional(),
    dueDate: dateOnlySchema.nullable().optional(),
    estimatedHours: estimatedHoursSchema,
    labelIds: z.array(uuidSchema).default([]),
    parentTaskId: uuidSchema.nullable().optional(),
    dependsOnTaskIds: z.array(uuidSchema).default([]),
  })
  .refine(
    (v) => !v.startDate || !v.dueDate || v.startDate <= v.dueDate,
    { message: 'Start date must be on or before the due date', path: ['dueDate'] },
  );
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/** Status and assignee are deliberately absent: they move through their own endpoints. */
export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(3).max(300).optional(),
    description: z.string().trim().max(50_000).nullable().optional(),
    priority: taskPrioritySchema.optional(),
    startDate: dateOnlySchema.nullable().optional(),
    dueDate: dateOnlySchema.nullable().optional(),
    estimatedHours: estimatedHoursSchema,
    labelIds: z.array(uuidSchema).optional(),
    parentTaskId: uuidSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
  .refine(
    (v) => !v.startDate || !v.dueDate || v.startDate <= v.dueDate,
    { message: 'Start date must be on or before the due date', path: ['dueDate'] },
  );
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const transitionTaskSchema = z
  .object({
    to: taskStatusSchema,
    comment: z.string().trim().min(1).max(10_000).optional(),
    blockedReason: z.string().trim().min(3, 'Say what the task is waiting on').max(2000).optional(),
    blockerType: blockerTypeSchema.optional(),
  })
  .refine((v) => v.to !== 'BLOCKED' || (!!v.blockedReason && !!v.blockerType), {
    message: 'Blocking a task needs a reason and a blocker type',
    path: ['blockedReason'],
  });
export type TransitionTaskInput = z.infer<typeof transitionTaskSchema>;

export const assignTaskSchema = z.object({
  assigneeId: uuidSchema.nullable(),
  reviewerId: uuidSchema.nullable().optional(),
  handoverNote: z.string().trim().min(3).max(5000).optional(),
});
export type AssignTaskInput = z.infer<typeof assignTaskSchema>;

export const updateProgressSchema = z.object({ progress: progressSchema });
export type UpdateProgressInput = z.infer<typeof updateProgressSchema>;

export const TASK_SORT_FIELDS = [
  'createdAt',
  'updatedAt',
  'dueDate',
  'priority',
  'lastActivityAt',
  'key',
] as const;
export const taskSortSchema = z.enum(TASK_SORT_FIELDS);
export type TaskSortField = z.infer<typeof taskSortSchema>;

export const listTasksQuerySchema = cursorPaginationSchema.extend({
  projectId: uuidSchema.optional(),
  assigneeId: z.union([uuidSchema, z.literal('me'), z.literal('none')]).optional(),
  reviewerId: z.union([uuidSchema, z.literal('me')]).optional(),
  watchedBy: z.literal('me').optional(),
  status: csvArray(taskStatusSchema),
  priority: csvArray(taskPrioritySchema),
  labelId: csvArray(uuidSchema),
  teamId: uuidSchema.optional(),
  dueFrom: dateOnlySchema.optional(),
  dueTo: dateOnlySchema.optional(),
  overdue: booleanQuerySchema,
  blocked: booleanQuerySchema,
  open: booleanQuerySchema,
  /** Active = open and not Backlog, matching the metric definition exactly. */
  active: booleanQuerySchema,
  /**
   * Due today and completed-this-week are evaluated on the server, because only
   * it knows the org time zone and which day the week starts on. The browser
   * must not compute either from its own clock.
   */
  dueToday: booleanQuerySchema,
  dueTomorrow: booleanQuerySchema,
  completedThisWeek: booleanQuerySchema,
  waitingReview: booleanQuerySchema,
  noUpdate: booleanQuerySchema,
  parentId: z.union([uuidSchema, z.literal('none')]).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  sort: taskSortSchema.default('lastActivityAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const addDependencySchema = z.object({
  dependsOnTaskId: uuidSchema,
  type: dependencyTypeSchema.default('BLOCKS'),
});
export type AddDependencyInput = z.infer<typeof addDependencySchema>;

/** Timeline: activity rows and comments merged, oldest first. */
export const activityEntrySchema = z.object({
  kind: z.literal('activity'),
  id: z.string(),
  actor: userSummarySchema.nullable(),
  action: z.string(),
  field: z.string().nullable(),
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  meta: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const commentEntrySchema = z.object({
  kind: z.literal('comment'),
  id: uuidSchema,
  author: userSummarySchema,
  body: z.string(),
  mentionedUserIds: z.array(uuidSchema),
  editedAt: z.string().nullable(),
  createdAt: z.string(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
});
export type CommentEntry = z.infer<typeof commentEntrySchema>;

export const timelineEntrySchema = z.discriminatedUnion('kind', [
  activityEntrySchema,
  commentEntrySchema,
]);
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

/** Activity action names. Kept as a closed list so the UI can render every one as a sentence. */
export const ACTIVITY_ACTIONS = [
  'task.created',
  'task.updated',
  'task.transitioned',
  'task.assigned',
  'task.reviewer_changed',
  'task.progress',
  'task.deleted',
  'task.restored',
  'task.label_added',
  'task.label_removed',
  'task.dependency_added',
  'task.dependency_removed',
  'task.watcher_added',
  'task.watcher_removed',
  'comment.created',
  'comment.edited',
  'comment.deleted',
  'attachment.created',
  'attachment.deleted',
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];
