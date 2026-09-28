import type { TaskStatus, UserRole } from './enums';
import { TASK_STATUSES } from './enums';

/**
 * The single source of truth for status changes.
 * The API rejects anything this file does not allow; the UI only renders buttons it allows.
 */

/** Who an actor is, relative to the task being changed. */
export type TransitionRole = 'SUPER_ADMIN' | 'TEAM_LEAD' | 'ASSIGNEE' | 'REVIEWER';

export type TransitionRequirement = 'comment' | 'blockedReason';

export interface TransitionContext {
  role: UserRole;
  isAssignee: boolean;
  isReviewer: boolean;
  isTeamLeadOfProject: boolean;
}

export interface TransitionRule {
  to: TaskStatus;
  /** Any one of these relationships is enough. */
  allow: readonly TransitionRole[];
  requires?: readonly TransitionRequirement[];
  /** Verb shown on the button that performs this move. */
  label: string;
}

export interface TransitionResult {
  ok: boolean;
  reason?: string;
  requires?: TransitionRequirement[];
}

const ANY_LEAD = ['SUPER_ADMIN', 'TEAM_LEAD'] as const;
const LEAD_OR_ASSIGNEE = ['SUPER_ADMIN', 'TEAM_LEAD', 'ASSIGNEE'] as const;
const LEAD_OR_REVIEWER = ['SUPER_ADMIN', 'TEAM_LEAD', 'REVIEWER'] as const;

export const TRANSITIONS: Record<TaskStatus, readonly TransitionRule[]> = {
  BACKLOG: [
    { to: 'ASSIGNED', allow: ANY_LEAD, label: 'Move to assigned' },
    { to: 'CANCELLED', allow: ANY_LEAD, requires: ['comment'], label: 'Cancel' },
  ],
  ASSIGNED: [
    { to: 'IN_PROGRESS', allow: LEAD_OR_ASSIGNEE, label: 'Start' },
    { to: 'BLOCKED', allow: LEAD_OR_ASSIGNEE, requires: ['blockedReason'], label: 'Block' },
    { to: 'BACKLOG', allow: ANY_LEAD, label: 'Move to backlog' },
    { to: 'CANCELLED', allow: ANY_LEAD, requires: ['comment'], label: 'Cancel' },
  ],
  IN_PROGRESS: [
    { to: 'READY_FOR_REVIEW', allow: LEAD_OR_ASSIGNEE, label: 'Submit for review' },
    { to: 'BLOCKED', allow: LEAD_OR_ASSIGNEE, requires: ['blockedReason'], label: 'Block' },
    { to: 'ASSIGNED', allow: ANY_LEAD, label: 'Move back to assigned' },
    { to: 'CANCELLED', allow: ANY_LEAD, requires: ['comment'], label: 'Cancel' },
  ],
  BLOCKED: [
    { to: 'IN_PROGRESS', allow: LEAD_OR_ASSIGNEE, label: 'Resume' },
    { to: 'ASSIGNED', allow: ANY_LEAD, label: 'Move back to assigned' },
    { to: 'CANCELLED', allow: ANY_LEAD, requires: ['comment'], label: 'Cancel' },
  ],
  READY_FOR_REVIEW: [
    { to: 'IN_REVIEW', allow: LEAD_OR_REVIEWER, label: 'Start review' },
    { to: 'COMPLETED', allow: LEAD_OR_REVIEWER, label: 'Approve' },
    {
      to: 'CHANGES_REQUESTED',
      allow: LEAD_OR_REVIEWER,
      requires: ['comment'],
      label: 'Request changes',
    },
    { to: 'IN_PROGRESS', allow: LEAD_OR_ASSIGNEE, label: 'Withdraw from review' },
    { to: 'CANCELLED', allow: ANY_LEAD, requires: ['comment'], label: 'Cancel' },
  ],
  IN_REVIEW: [
    { to: 'COMPLETED', allow: LEAD_OR_REVIEWER, label: 'Approve' },
    {
      to: 'CHANGES_REQUESTED',
      allow: LEAD_OR_REVIEWER,
      requires: ['comment'],
      label: 'Request changes',
    },
    { to: 'BLOCKED', allow: LEAD_OR_REVIEWER, requires: ['blockedReason'], label: 'Block' },
    { to: 'CANCELLED', allow: ANY_LEAD, requires: ['comment'], label: 'Cancel' },
  ],
  CHANGES_REQUESTED: [
    { to: 'IN_PROGRESS', allow: LEAD_OR_ASSIGNEE, label: 'Resume work' },
    { to: 'BLOCKED', allow: LEAD_OR_ASSIGNEE, requires: ['blockedReason'], label: 'Block' },
    { to: 'CANCELLED', allow: ANY_LEAD, requires: ['comment'], label: 'Cancel' },
  ],
  // Reopening is lead-only, by design.
  COMPLETED: [{ to: 'IN_PROGRESS', allow: ANY_LEAD, requires: ['comment'], label: 'Reopen' }],
  CANCELLED: [
    { to: 'BACKLOG', allow: ANY_LEAD, requires: ['comment'], label: 'Reopen to backlog' },
    { to: 'ASSIGNED', allow: ANY_LEAD, requires: ['comment'], label: 'Reopen as assigned' },
  ],
};

function matchesRole(allowed: TransitionRole, ctx: TransitionContext): boolean {
  switch (allowed) {
    case 'SUPER_ADMIN':
      return ctx.role === 'SUPER_ADMIN';
    case 'TEAM_LEAD':
      return ctx.role === 'TEAM_LEAD' && ctx.isTeamLeadOfProject;
    case 'ASSIGNEE':
      return ctx.isAssignee;
    case 'REVIEWER':
      return ctx.isReviewer;
  }
}

export function findRule(from: TaskStatus, to: TaskStatus): TransitionRule | undefined {
  return TRANSITIONS[from].find((rule) => rule.to === to);
}

/**
 * Can this actor move the task from one status to another?
 * The returned requires list tells the caller which extra input it must supply; it comes back
 * on success too, so the UI knows which dialog to open before sending the request.
 */
export function canTransition(
  from: TaskStatus,
  to: TaskStatus,
  ctx: TransitionContext,
): TransitionResult {
  if (from === to) {
    return { ok: false, reason: 'Task is already ' + to + '.' };
  }

  const rule = findRule(from, to);
  if (!rule) {
    return { ok: false, reason: 'Cannot move a task from ' + from + ' to ' + to + '.' };
  }

  const permitted = rule.allow.some((allowed) => matchesRole(allowed, ctx));
  if (!permitted) {
    return { ok: false, reason: 'You are not allowed to ' + rule.label.toLowerCase() + ' this task.' };
  }

  return { ok: true, requires: rule.requires ? [...rule.requires] : [] };
}

/** Every move this actor may make from the current status. Drives the UI buttons. */
export function availableTransitions(
  from: TaskStatus,
  ctx: TransitionContext,
): Array<TransitionRule & { requires: TransitionRequirement[] }> {
  return TRANSITIONS[from]
    .filter((rule) => rule.allow.some((allowed) => matchesRole(allowed, ctx)))
    .map((rule) => ({ ...rule, requires: rule.requires ? [...rule.requires] : [] }));
}

/** Statuses a board card may be dropped onto, ignoring who is asking. */
export function reachableStatuses(from: TaskStatus): TaskStatus[] {
  return TRANSITIONS[from].map((rule) => rule.to);
}

/**
 * Field changes the server applies alongside a transition.
 * Kept here so the UI can predict them and the API applies them in one place.
 * An undefined value means "leave this field alone".
 */
export interface TransitionEffects {
  progress?: number;
  completedAt: Date | null | undefined;
  blockedAt: Date | null | undefined;
  clearBlockerFields: boolean;
}

export function transitionEffects(
  from: TaskStatus,
  to: TaskStatus,
  now: Date,
  currentProgress: number,
): TransitionEffects {
  const effects: TransitionEffects = {
    completedAt: undefined,
    blockedAt: undefined,
    clearBlockerFields: false,
  };

  if (to === 'BLOCKED') {
    effects.blockedAt = now;
  } else if (from === 'BLOCKED') {
    effects.blockedAt = null;
    effects.clearBlockerFields = true;
  }

  if (to === 'COMPLETED') {
    effects.completedAt = now;
    effects.progress = 100;
  } else if (from === 'COMPLETED') {
    // Reopened: the task is not done any more, so drop the completion stamp.
    effects.completedAt = null;
    if (currentProgress === 100) effects.progress = 90;
  }

  return effects;
}

/** Board column order, left to right. */
export const BOARD_COLUMNS: TaskStatus[] = [
  'BACKLOG',
  'ASSIGNED',
  'IN_PROGRESS',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'COMPLETED',
  'CANCELLED',
];

/** Columns hidden until the user toggles them on. */
export const COLLAPSED_BOARD_COLUMNS: TaskStatus[] = ['BACKLOG', 'CANCELLED'];

export const ALL_STATUSES: readonly TaskStatus[] = TASK_STATUSES;
