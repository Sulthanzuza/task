import type { TaskStatus } from '@tm/shared';
import { COMMENT_SELF_EDIT_WINDOW_MINUTES } from '@tm/shared';
import type { Actor } from '../../middleware/authenticate';
import { ForbiddenError } from '../../lib/errors';

/**
 * The permission matrix from the brief, in one place.
 *
 * Every rule answers: may this actor do this action to this resource?
 * Routes call a coarse role gate; services call this with the real row they loaded,
 * because only the row knows which team and which person a task belongs to.
 */

export type Action =
  // Administration
  | 'user.manage'
  | 'team.manage'
  | 'org.manage'
  // Projects
  | 'project.create'
  | 'project.update'
  | 'project.archive'
  | 'project.view'
  // Tasks
  | 'task.view'
  | 'task.create'
  | 'task.update'
  | 'task.assign'
  | 'task.work'
  | 'task.review'
  | 'task.cancelOrReopen'
  | 'task.delete'
  | 'task.progress'
  | 'task.comment'
  | 'task.attach'
  | 'task.watch'
  // Comments
  | 'comment.edit'
  | 'comment.delete'
  // Reporting
  | 'dashboard.view'
  | 'member.view'
  | 'workload.view'
  | 'reports.view';

export interface TaskResource {
  kind: 'task';
  projectId: string;
  teamId: string;
  assigneeId: string | null;
  reviewerId: string | null;
  createdBy: string;
  watcherIds: string[];
  parentTaskId: string | null;
  status: TaskStatus;
}

export interface ProjectResource {
  kind: 'project';
  teamId: string;
}

export interface TeamResource {
  kind: 'team';
  teamId: string;
}

export interface UserResource {
  kind: 'user';
  userId: string;
  teamIds: string[];
}

export interface CommentResource {
  kind: 'comment';
  authorId: string;
  createdAt: Date;
  task: TaskResource;
}

export interface OrgResource {
  kind: 'org';
}

export type Resource =
  | TaskResource
  | ProjectResource
  | TeamResource
  | UserResource
  | CommentResource
  | OrgResource;

const isSuperAdmin = (actor: Actor): boolean => actor.role === 'SUPER_ADMIN';

/** A team lead's authority is limited to the teams they actually lead. */
const leadsTeam = (actor: Actor, teamId: string): boolean =>
  actor.role === 'TEAM_LEAD' && actor.ledTeamIds.includes(teamId);

const inTeam = (actor: Actor, teamId: string): boolean => actor.teamIds.includes(teamId);

const isAssignee = (actor: Actor, task: TaskResource): boolean => task.assigneeId === actor.id;
const isReviewer = (actor: Actor, task: TaskResource): boolean => task.reviewerId === actor.id;
const isWatcher = (actor: Actor, task: TaskResource): boolean =>
  task.watcherIds.includes(actor.id);
const isInvolved = (actor: Actor, task: TaskResource): boolean =>
  isAssignee(actor, task) ||
  isReviewer(actor, task) ||
  isWatcher(actor, task) ||
  task.createdBy === actor.id;

function checkTask(actor: Actor, action: Action, task: TaskResource): boolean {
  if (isSuperAdmin(actor)) return true;
  const lead = leadsTeam(actor, task.teamId);

  switch (action) {
    // Anyone on the team can read their team's tasks; so can anyone involved in one.
    case 'task.view':
      return lead || inTeam(actor, task.teamId) || isInvolved(actor, task);

    // Members may only create subtasks, and only under a task they are working on.
    case 'task.create':
      return lead || (task.parentTaskId !== null && isInvolved(actor, task));

    // Editing fields such as priority and due date is a lead action.
    // A member asks by commenting.
    case 'task.update':
    case 'task.assign':
      return lead;

    // Start, block, resume, submit for review: the assignee runs their own task.
    case 'task.work':
      return lead || isAssignee(actor, task);

    // Move to in review, approve, request changes: only the named reviewer.
    case 'task.review':
      return lead || isReviewer(actor, task);

    case 'task.cancelOrReopen':
    case 'task.delete':
      return lead;

    // Progress, comments, attachments and watching are open to anyone involved.
    case 'task.progress':
    case 'task.comment':
    case 'task.attach':
    case 'task.watch':
      return lead || isInvolved(actor, task) || inTeam(actor, task.teamId);

    default:
      return false;
  }
}

function checkComment(actor: Actor, action: Action, comment: CommentResource, now: Date): boolean {
  if (isSuperAdmin(actor)) return true;
  const lead = leadsTeam(actor, comment.task.teamId);
  const isAuthor = comment.authorId === actor.id;
  const ageMinutes = (now.getTime() - comment.createdAt.getTime()) / 60_000;
  const withinWindow = ageMinutes <= COMMENT_SELF_EDIT_WINDOW_MINUTES;

  switch (action) {
    // You can always fix your own wording; the edit is stamped so the change is visible.
    case 'comment.edit':
      return isAuthor;
    // Members may delete their own comment only in the first fifteen minutes.
    case 'comment.delete':
      return lead || (isAuthor && withinWindow);
    default:
      return false;
  }
}

function checkProject(actor: Actor, action: Action, project: ProjectResource): boolean {
  if (isSuperAdmin(actor)) return true;
  const lead = leadsTeam(actor, project.teamId);

  switch (action) {
    case 'project.view':
      return lead || inTeam(actor, project.teamId);
    case 'project.create':
    case 'project.update':
    case 'project.archive':
      return lead;
    default:
      return false;
  }
}

function checkTeam(actor: Actor, action: Action, team: TeamResource): boolean {
  if (isSuperAdmin(actor)) return true;
  const lead = leadsTeam(actor, team.teamId);

  switch (action) {
    // A lead sees their own team's dashboard, member pages, workload and reports.
    case 'dashboard.view':
    case 'member.view':
    case 'workload.view':
    case 'reports.view':
      return lead;
    // Creating teams and moving people between them stays with the super admin.
    case 'team.manage':
      return false;
    default:
      return false;
  }
}

function checkUser(actor: Actor, action: Action, user: UserResource): boolean {
  if (isSuperAdmin(actor)) return true;

  switch (action) {
    // Members may open their own page and see exactly what their lead sees about them.
    case 'member.view':
      return user.userId === actor.id || user.teamIds.some((id) => leadsTeam(actor, id));
    case 'user.manage':
      return false;
    default:
      return false;
  }
}

export function can(actor: Actor, action: Action, resource: Resource, now = new Date()): boolean {
  switch (resource.kind) {
    case 'org':
      // Org settings are the super admin's alone.
      return isSuperAdmin(actor);
    case 'task':
      return checkTask(actor, action, resource);
    case 'comment':
      return checkComment(actor, action, resource, now);
    case 'project':
      return checkProject(actor, action, resource);
    case 'team':
      return checkTeam(actor, action, resource);
    case 'user':
      return checkUser(actor, action, resource);
  }
}

/** The form services use: throws a 403 rather than returning false. */
export function authorize(
  actor: Actor,
  action: Action,
  resource: Resource,
  now = new Date(),
): void {
  if (!can(actor, action, resource, now)) {
    throw new ForbiddenError(DENIAL_MESSAGES[action] ?? 'You do not have access to that.');
  }
}

const DENIAL_MESSAGES: Partial<Record<Action, string>> = {
  'task.update': 'Only a team lead can change this task. Leave a comment to ask for a change.',
  'task.assign': 'Only a team lead can assign this task.',
  'task.work': 'Only the assignee or a team lead can move this task along.',
  'task.review': 'Only the reviewer or a team lead can review this task.',
  'task.cancelOrReopen': 'Only a team lead can cancel or reopen a task.',
  'task.delete': 'Only a team lead can delete a task.',
  'comment.delete': 'You can delete your own comment for fifteen minutes after posting it.',
  'user.manage': 'Only a super admin can manage users.',
  'team.manage': 'Only a super admin can manage teams.',
  'org.manage': 'Only a super admin can change organisation settings.',
  'dashboard.view': 'You can only see the dashboard for a team you lead.',
};
