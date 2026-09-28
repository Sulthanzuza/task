import { describe, expect, it } from 'vitest';
import type { Actor } from '../../middleware/authenticate';
import {
  authorize,
  can,
  type CommentResource,
  type TaskResource,
  type UserResource,
} from './authorize';
import { ForbiddenError } from '../../lib/errors';

const TEAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const superAdmin: Actor = { id: 'u-admin', role: 'SUPER_ADMIN', teamIds: [], ledTeamIds: [] };
const leadA: Actor = { id: 'u-lead-a', role: 'TEAM_LEAD', teamIds: [TEAM_A], ledTeamIds: [TEAM_A] };
const leadB: Actor = { id: 'u-lead-b', role: 'TEAM_LEAD', teamIds: [TEAM_B], ledTeamIds: [TEAM_B] };
const assignee: Actor = { id: 'u-rahul', role: 'MEMBER', teamIds: [TEAM_A], ledTeamIds: [] };
const reviewer: Actor = { id: 'u-arun', role: 'MEMBER', teamIds: [TEAM_A], ledTeamIds: [] };
const teammate: Actor = { id: 'u-akhil', role: 'MEMBER', teamIds: [TEAM_A], ledTeamIds: [] };
const outsider: Actor = { id: 'u-faisal', role: 'MEMBER', teamIds: [TEAM_B], ledTeamIds: [] };

function task(overrides: Partial<TaskResource> = {}): TaskResource {
  return {
    kind: 'task',
    projectId: 'p-erp',
    teamId: TEAM_A,
    assigneeId: assignee.id,
    reviewerId: reviewer.id,
    createdBy: leadA.id,
    watcherIds: [assignee.id, reviewer.id, leadA.id],
    parentTaskId: null,
    status: 'IN_PROGRESS',
    ...overrides,
  };
}

/**
 * One row of the permission matrix: the action, and which of the six actors may do it.
 * Anyone not listed must be refused, so a widened rule fails a test.
 */
const MATRIX: Array<{ action: Parameters<typeof can>[1]; allowed: Actor[]; note: string }> = [
  { action: 'task.view', allowed: [superAdmin, leadA, assignee, reviewer, teammate], note: 'team members read their team’s tasks' },
  { action: 'task.update', allowed: [superAdmin, leadA], note: 'only leads change priority and dates' },
  { action: 'task.assign', allowed: [superAdmin, leadA], note: 'only leads assign' },
  { action: 'task.work', allowed: [superAdmin, leadA, assignee], note: 'the assignee runs their own task' },
  { action: 'task.review', allowed: [superAdmin, leadA, reviewer], note: 'only the reviewer reviews' },
  { action: 'task.cancelOrReopen', allowed: [superAdmin, leadA], note: 'leads cancel and reopen' },
  { action: 'task.delete', allowed: [superAdmin, leadA], note: 'leads delete' },
  { action: 'task.progress', allowed: [superAdmin, leadA, assignee, reviewer, teammate], note: 'anyone on the team updates progress' },
  { action: 'task.comment', allowed: [superAdmin, leadA, assignee, reviewer, teammate], note: 'anyone on the team comments' },
  { action: 'task.attach', allowed: [superAdmin, leadA, assignee, reviewer, teammate], note: 'anyone on the team attaches' },
];

describe('the task permission matrix', () => {
  const everyone = [superAdmin, leadA, leadB, assignee, reviewer, teammate, outsider];

  for (const row of MATRIX) {
    it(row.action + ': ' + row.note, () => {
      for (const actor of everyone) {
        const expected = row.allowed.includes(actor);
        expect(can(actor, row.action, task()), actor.id + ' -> ' + row.action).toBe(expected);
      }
    });
  }

  it('never lets another team’s lead near the task', () => {
    for (const row of MATRIX) {
      expect(can(leadB, row.action, task())).toBe(false);
    }
  });

  it('never lets another team’s member near the task', () => {
    for (const row of MATRIX) {
      expect(can(outsider, row.action, task())).toBe(false);
    }
  });
});

describe('members creating tasks', () => {
  it('refuses a member creating a top-level task', () => {
    expect(can(assignee, 'task.create', task({ parentTaskId: null }))).toBe(false);
  });

  it('allows a member creating a subtask of a task they are on', () => {
    expect(can(assignee, 'task.create', task({ parentTaskId: 'parent-1' }))).toBe(true);
  });

  it('refuses a member creating a subtask of a task they are not on', () => {
    const notTheirs = task({
      parentTaskId: 'parent-1',
      assigneeId: 'someone-else',
      reviewerId: null,
      createdBy: leadA.id,
      watcherIds: [],
    });
    expect(can(teammate, 'task.create', notTheirs)).toBe(false);
  });

  it('always allows a lead', () => {
    expect(can(leadA, 'task.create', task({ parentTaskId: null }))).toBe(true);
  });
});

describe('a reviewer who is not the assignee', () => {
  it('cannot start the work', () => {
    expect(can(reviewer, 'task.work', task())).toBe(false);
  });

  it('can approve it', () => {
    expect(can(reviewer, 'task.review', task())).toBe(true);
  });
});

describe('an assignee who is not the reviewer', () => {
  it('cannot approve their own work', () => {
    expect(can(assignee, 'task.review', task())).toBe(false);
  });
});

describe('comments', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const fresh = new Date('2026-09-28T11:50:00Z'); // 10 minutes old
  const old = new Date('2026-09-28T11:00:00Z'); // an hour old

  function comment(authorId: string, createdAt: Date): CommentResource {
    return { kind: 'comment', authorId, createdAt, task: task() };
  }

  it('lets the author edit their own comment at any time', () => {
    expect(can(assignee, 'comment.edit', comment(assignee.id, old), now)).toBe(true);
  });

  it('does not let anyone edit someone else’s comment', () => {
    expect(can(leadA, 'comment.edit', comment(assignee.id, fresh), now)).toBe(false);
    expect(can(teammate, 'comment.edit', comment(assignee.id, fresh), now)).toBe(false);
  });

  it('lets a member delete their own comment inside the fifteen minute window', () => {
    expect(can(assignee, 'comment.delete', comment(assignee.id, fresh), now)).toBe(true);
  });

  it('stops a member deleting their own comment after the window', () => {
    expect(can(assignee, 'comment.delete', comment(assignee.id, old), now)).toBe(false);
  });

  it('lets a lead delete any comment on their team’s task', () => {
    expect(can(leadA, 'comment.delete', comment(assignee.id, old), now)).toBe(true);
  });

  it('stops another team’s lead deleting it', () => {
    expect(can(leadB, 'comment.delete', comment(assignee.id, old), now)).toBe(false);
  });
});

describe('projects', () => {
  const projectA = { kind: 'project', teamId: TEAM_A } as const;

  it('lets a super admin do everything', () => {
    for (const action of ['project.create', 'project.update', 'project.archive'] as const) {
      expect(can(superAdmin, action, projectA)).toBe(true);
    }
  });

  it('lets a lead manage their own team’s projects only', () => {
    expect(can(leadA, 'project.create', projectA)).toBe(true);
    expect(can(leadB, 'project.create', projectA)).toBe(false);
  });

  it('lets members read but not change', () => {
    expect(can(teammate, 'project.view', projectA)).toBe(true);
    expect(can(teammate, 'project.update', projectA)).toBe(false);
  });

  it('hides another team’s project from a member', () => {
    expect(can(outsider, 'project.view', projectA)).toBe(false);
  });
});

describe('dashboards and reporting', () => {
  const teamA = { kind: 'team', teamId: TEAM_A } as const;

  it('gives the lead their own team only', () => {
    for (const action of ['dashboard.view', 'workload.view', 'reports.view'] as const) {
      expect(can(leadA, action, teamA)).toBe(true);
      expect(can(leadB, action, teamA)).toBe(false);
    }
  });

  it('keeps members off the team dashboard', () => {
    expect(can(teammate, 'dashboard.view', teamA)).toBe(false);
  });

  it('lets a member open their own page', () => {
    const self: UserResource = { kind: 'user', userId: teammate.id, teamIds: [TEAM_A] };
    expect(can(teammate, 'member.view', self)).toBe(true);
  });

  it('stops a member opening a colleague’s page', () => {
    const other: UserResource = { kind: 'user', userId: assignee.id, teamIds: [TEAM_A] };
    expect(can(teammate, 'member.view', other)).toBe(false);
  });

  it('lets a lead open a page for someone in their team', () => {
    const member: UserResource = { kind: 'user', userId: assignee.id, teamIds: [TEAM_A] };
    expect(can(leadA, 'member.view', member)).toBe(true);
    expect(can(leadB, 'member.view', member)).toBe(false);
  });
});

describe('administration', () => {
  it('is the super admin’s alone', () => {
    const org = { kind: 'org' } as const;
    expect(can(superAdmin, 'org.manage', org)).toBe(true);
    expect(can(leadA, 'org.manage', org)).toBe(false);
    expect(can(teammate, 'org.manage', org)).toBe(false);
  });

  it('does not let a lead manage users or teams', () => {
    const someone: UserResource = { kind: 'user', userId: 'x', teamIds: [TEAM_A] };
    expect(can(leadA, 'user.manage', someone)).toBe(false);
    expect(can(leadA, 'team.manage', { kind: 'team', teamId: TEAM_A })).toBe(false);
  });
});

describe('authorize', () => {
  it('throws a ForbiddenError with a message the user can act on', () => {
    expect(() => authorize(teammate, 'task.update', task())).toThrow(ForbiddenError);
    try {
      authorize(teammate, 'task.update', task());
    } catch (error) {
      expect((error as ForbiddenError).status).toBe(403);
      expect((error as ForbiddenError).message).toContain('Leave a comment');
    }
  });

  it('returns quietly when allowed', () => {
    expect(() => authorize(leadA, 'task.update', task())).not.toThrow();
  });
});

describe('a team lead who leads no team', () => {
  // Role alone is not authority: the lead must actually lead the task's team.
  const unattached: Actor = { id: 'u-floating', role: 'TEAM_LEAD', teamIds: [TEAM_A], ledTeamIds: [] };

  it('is treated as an ordinary team member', () => {
    expect(can(unattached, 'task.view', task())).toBe(true);
    expect(can(unattached, 'task.update', task())).toBe(false);
    expect(can(unattached, 'task.delete', task())).toBe(false);
  });
});
