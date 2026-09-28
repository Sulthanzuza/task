import { describe, expect, it } from 'vitest';
import { TASK_STATUSES, type TaskStatus } from './enums';
import {
  TRANSITIONS,
  availableTransitions,
  canTransition,
  transitionEffects,
  type TransitionContext,
} from './workflow';

const superAdmin: TransitionContext = {
  role: 'SUPER_ADMIN',
  isAssignee: false,
  isReviewer: false,
  isTeamLeadOfProject: false,
};
const lead: TransitionContext = {
  role: 'TEAM_LEAD',
  isAssignee: false,
  isReviewer: false,
  isTeamLeadOfProject: true,
};
const otherLead: TransitionContext = {
  role: 'TEAM_LEAD',
  isAssignee: false,
  isReviewer: false,
  isTeamLeadOfProject: false,
};
const assignee: TransitionContext = {
  role: 'MEMBER',
  isAssignee: true,
  isReviewer: false,
  isTeamLeadOfProject: false,
};
const reviewer: TransitionContext = {
  role: 'MEMBER',
  isAssignee: false,
  isReviewer: true,
  isTeamLeadOfProject: false,
};
const bystander: TransitionContext = {
  role: 'MEMBER',
  isAssignee: false,
  isReviewer: false,
  isTeamLeadOfProject: false,
};

describe('canTransition', () => {
  it('refuses a move to the same status', () => {
    expect(canTransition('IN_PROGRESS', 'IN_PROGRESS', lead).ok).toBe(false);
  });

  it('refuses a move that is not in the table', () => {
    const result = canTransition('BACKLOG', 'COMPLETED', superAdmin);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Cannot move');
  });

  it('will not let anyone skip review', () => {
    for (const ctx of [superAdmin, lead, assignee, reviewer]) {
      expect(canTransition('IN_PROGRESS', 'COMPLETED', ctx).ok).toBe(false);
    }
  });

  it('lets the assignee run their own task through to review', () => {
    expect(canTransition('ASSIGNED', 'IN_PROGRESS', assignee).ok).toBe(true);
    expect(canTransition('IN_PROGRESS', 'READY_FOR_REVIEW', assignee).ok).toBe(true);
  });

  it('does not let a bystander touch someone else’s task', () => {
    expect(canTransition('ASSIGNED', 'IN_PROGRESS', bystander).ok).toBe(false);
    expect(canTransition('READY_FOR_REVIEW', 'COMPLETED', bystander).ok).toBe(false);
  });

  it('lets only the reviewer or a lead approve', () => {
    expect(canTransition('IN_REVIEW', 'COMPLETED', reviewer).ok).toBe(true);
    expect(canTransition('IN_REVIEW', 'COMPLETED', lead).ok).toBe(true);
    expect(canTransition('IN_REVIEW', 'COMPLETED', superAdmin).ok).toBe(true);
    expect(canTransition('IN_REVIEW', 'COMPLETED', assignee).ok).toBe(false);
  });

  it('keeps a team lead out of another team’s project', () => {
    expect(canTransition('BACKLOG', 'ASSIGNED', otherLead).ok).toBe(false);
    expect(canTransition('COMPLETED', 'IN_PROGRESS', otherLead).ok).toBe(false);
  });

  it('only lets leads reopen a completed task', () => {
    expect(canTransition('COMPLETED', 'IN_PROGRESS', lead).ok).toBe(true);
    expect(canTransition('COMPLETED', 'IN_PROGRESS', assignee).ok).toBe(false);
    expect(canTransition('COMPLETED', 'IN_PROGRESS', reviewer).ok).toBe(false);
  });

  it('only lets leads cancel', () => {
    expect(canTransition('IN_PROGRESS', 'CANCELLED', lead).ok).toBe(true);
    expect(canTransition('IN_PROGRESS', 'CANCELLED', assignee).ok).toBe(false);
  });

  it('asks for a reason when blocking', () => {
    const result = canTransition('IN_PROGRESS', 'BLOCKED', assignee);
    expect(result.ok).toBe(true);
    expect(result.requires).toEqual(['blockedReason']);
  });

  it('asks for a comment when requesting changes', () => {
    const result = canTransition('IN_REVIEW', 'CHANGES_REQUESTED', reviewer);
    expect(result.ok).toBe(true);
    expect(result.requires).toEqual(['comment']);
  });

  it('reports no extra input for a plain move', () => {
    expect(canTransition('ASSIGNED', 'IN_PROGRESS', assignee).requires).toEqual([]);
  });
});

describe('the transition table itself', () => {
  it('covers every status', () => {
    for (const status of TASK_STATUSES) {
      expect(TRANSITIONS[status]).toBeDefined();
    }
  });

  it('never points at a status that does not exist, or at itself', () => {
    for (const status of TASK_STATUSES) {
      for (const rule of TRANSITIONS[status]) {
        expect(TASK_STATUSES).toContain(rule.to);
        expect(rule.to).not.toBe(status);
        expect(rule.allow.length).toBeGreaterThan(0);
      }
    }
  });

  it('lists each target at most once per source', () => {
    for (const status of TASK_STATUSES) {
      const targets = TRANSITIONS[status].map((r) => r.to);
      expect(new Set(targets).size).toBe(targets.length);
    }
  });

  it('leaves every status reachable except the starting one', () => {
    const reachable = new Set<TaskStatus>(['BACKLOG']);
    for (const status of TASK_STATUSES) {
      for (const rule of TRANSITIONS[status]) reachable.add(rule.to);
    }
    for (const status of TASK_STATUSES) expect(reachable.has(status)).toBe(true);
  });
});

describe('availableTransitions', () => {
  it('gives a bystander nothing to click', () => {
    expect(availableTransitions('IN_PROGRESS', bystander)).toEqual([]);
  });

  it('gives the assignee exactly the moves they may make', () => {
    const moves = availableTransitions('IN_PROGRESS', assignee).map((m) => m.to);
    expect(moves.sort()).toEqual(['BLOCKED', 'READY_FOR_REVIEW']);
  });

  it('gives a lead the full set including cancel', () => {
    const moves = availableTransitions('IN_PROGRESS', lead).map((m) => m.to);
    expect(moves).toContain('CANCELLED');
    expect(moves).toContain('READY_FOR_REVIEW');
  });
});

describe('transitionEffects', () => {
  const now = new Date('2026-09-28T10:00:00.000Z');

  it('stamps blocked_at on the way in and clears it on the way out', () => {
    expect(transitionEffects('IN_PROGRESS', 'BLOCKED', now, 30).blockedAt).toEqual(now);

    const resumed = transitionEffects('BLOCKED', 'IN_PROGRESS', now, 30);
    expect(resumed.blockedAt).toBeNull();
    expect(resumed.clearBlockerFields).toBe(true);
  });

  it('completes at 100 percent', () => {
    const done = transitionEffects('IN_REVIEW', 'COMPLETED', now, 80);
    expect(done.progress).toBe(100);
    expect(done.completedAt).toEqual(now);
  });

  it('drops the completion stamp when a task is reopened', () => {
    const reopened = transitionEffects('COMPLETED', 'IN_PROGRESS', now, 100);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.progress).toBe(90);
  });

  it('leaves untouched fields undefined so the caller can skip them', () => {
    const plain = transitionEffects('ASSIGNED', 'IN_PROGRESS', now, 0);
    expect(plain.completedAt).toBeUndefined();
    expect(plain.blockedAt).toBeUndefined();
    expect(plain.progress).toBeUndefined();
  });
});
