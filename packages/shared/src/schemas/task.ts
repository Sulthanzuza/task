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
  /**
   * Working days past the due date, counted on the server against the
   * organisation's weekends and holidays. Null when the task is not overdue.
   * The browser cannot work this out: it does not know the calendar.
   */
  workingDaysLate: z.number().int().nullable(),
  /**
   * Working days a task has been blocked, counted on the server against the
   * organisation's calendar. Null unless it is blocked right now.
   */
  workingDaysBlocked: z.number().int().nullable(),
  lastActivityAt: z.string(),
  completedAt: z.string().nullable(),
  parentTaskId: uuidSchema.nullable(),
  /**
   * One piece of work given to several people, each with their own copy.
   *
   * The group row is a container: its children are the real tasks, and its
   * status and progress are read off them rather than set. It is left out of
   * every count, or a group of eight would make nine tasks out of eight.
   */
  isGroup: z.boolean(),
  /** Set when this task is one person's copy inside a group. */
  parentIsGroup: z.boolean(),
  /** The group's key, so a child can link back to it by name. */
  parentKey: z.string().nullable(),
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

/** A row in the People table on a group task. */
export const groupChildSchema = z.object({
  id: uuidSchema,
  key: z.string(),
  assignee: userSummarySchema.nullable(),
  status: taskStatusSchema,
  progress: z.number().int(),
  dueDate: dateOnlySchema.nullable(),
  lastActivityAt: z.string(),
});
export type GroupChild = z.infer<typeof groupChildSchema>;

/** What a group looks like at a glance: "5 of 8 done, 2 in progress, 1 blocked". */
export interface GroupTally {
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
  cancelled: number;
  overdue: number;
}

export const taskDetailSchema = taskSummarySchema.extend({
  description: z.string().nullable(),
  createdBy: userSummarySchema,
  watcherIds: z.array(uuidSchema),
  /**
   * The same people with their names, so the task page can list them without
   * a second request per id. watcherIds stays because several screens only
   * need to ask "am I following this?".
   */
  watchers: z.array(userSummarySchema),
  subtaskCount: z.object({ total: z.number().int(), done: z.number().int() }),
  /**
   * The children of a group task, one per person, newest state first-hand.
   * Empty for everything else, so the detail page can simply check length.
   */
  groupChildren: z.array(groupChildSchema),
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
    /**
     * Two or more people makes this a group task: a parent carrying the
     * shared detail, and one real task per person underneath it.
     *
     * Separate from assigneeId rather than replacing it, because one person
     * is still one task and nothing about that should change.
     */
    assigneeIds: z.array(uuidSchema).max(50).optional(),
    reviewerId: uuidSchema.nullable().optional(),
    priority: taskPrioritySchema.default('MEDIUM'),
    startDate: dateOnlySchema.nullable().optional(),
    dueDate: dateOnlySchema.nullable().optional(),
    estimatedHours: estimatedHoursSchema,
    labelIds: z.array(uuidSchema).default([]),
    parentTaskId: uuidSchema.nullable().optional(),
    dependsOnTaskIds: z.array(uuidSchema).default([]),
  })
  .refine((v) => !v.startDate || !v.dueDate || v.startDate <= v.dueDate, {
    message: 'Start date must be on or before the due date',
    path: ['dueDate'],
  });
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
  .refine((v) => !v.startDate || !v.dueDate || v.startDate <= v.dueDate, {
    message: 'Start date must be on or before the due date',
    path: ['dueDate'],
  });
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const transitionTaskSchema = z
  .object({
    to: taskStatusSchema,
    /*
     * The status the person was looking at when they confirmed. Optional,
     * because a script or a test may not care, but the UI always sends it:
     * a confirmation dialog describes one specific move, and if the task has
     * moved since, that move is not the one that would be applied.
     */
    expectedStatus: taskStatusSchema.optional(),
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
  /*
   * When a task was made, and when it was finished.
   *
   * Added for the Reports page, where every number hands out the query that
   * opens the rows behind it. Without these, a report saying "23 completed
   * last month" linked to a list of every completion there has ever been,
   * and the two disagreed by more the longer the project ran.
   */
  createdFrom: dateOnlySchema.optional(),
  createdTo: dateOnlySchema.optional(),
  completedFrom: dateOnlySchema.optional(),
  completedTo: dateOnlySchema.optional(),
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
  /**
   * Whether the container rows of group tasks are included.
   *
   * The task list wants them: a group is a thing a lead reads as one line.
   * The board does not: a column holding both the group and its eight
   * children shows the same work nine times. Default is to include them,
   * because leaving them out silently is the more surprising answer.
   */
  includeGroups: booleanQuerySchema,
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
  'task.imported',
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

/** Timeline: activity rows and comments merged, oldest first. */
export const activityEntrySchema = z.object({
  kind: z.literal('activity'),
  id: z.string(),
  actor: userSummarySchema.nullable(),
  // The closed list, not a free string: the UI renders every one of these as
  // a sentence, and a switch over a string can only fall through to printing
  // the action name at somebody.
  action: z.enum(ACTIVITY_ACTIONS),
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

/**
 * Per-column counts for the board.
 *
 * Counted on the server with the shared predicates, so a column header agrees
 * with the dashboard and does not merely count whichever page of cards the
 * browser happens to have loaded.
 */
export const boardSummarySchema = z.object({
  counts: z.record(taskStatusSchema, z.number().int()),
  open: z.number().int(),
  active: z.number().int(),
  /** Columns the board hides until the user asks for them. */
  collapsed: z.array(taskStatusSchema),
});
export type BoardSummary = z.infer<typeof boardSummarySchema>;

export const boardQuerySchema = z.object({
  projectId: uuidSchema.optional(),
  teamId: uuidSchema.optional(),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

/**
 * A person's own recent activity, for their member page.
 *
 * It carries the task it happened on, because "changed the status" means
 * nothing without saying of what.
 */
export const memberActivityEntrySchema = activityEntrySchema.extend({
  task: z.object({
    id: uuidSchema,
    key: z.string(),
    title: z.string(),
    status: taskStatusSchema,
  }),
});
export type MemberActivityEntry = z.infer<typeof memberActivityEntrySchema>;

// ---------------------------------------------------------------------------
// Group tasks
// ---------------------------------------------------------------------------

/** Adding somebody to a group after it was created. */
export const addGroupMemberSchema = z.object({ userId: uuidSchema });
export type AddGroupMemberInput = z.infer<typeof addGroupMemberSchema>;

/**
 * Whether an edit to the parent should reach the children.
 *
 * Asked rather than assumed: changing a shared due date usually should move
 * everybody's, and changing a title to fix a typo usually should too, but
 * neither is safe to do silently to work somebody has already started.
 */
export const updateGroupSchema = updateTaskSchema.and(
  z.object({ applyToChildren: z.boolean().optional() }),
);
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

/**
 * The fields a group shares with its children.
 *
 * Status, progress and assignee are deliberately not here: those are what
 * make a child its own task.
 */
export const GROUP_SHARED_FIELDS = [
  'title',
  'description',
  'priority',
  'dueDate',
  'startDate',
  'estimatedHours',
] as const;
