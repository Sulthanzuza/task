import { describe, expect, it } from 'vitest';
import type { TaskStatus } from './enums';
import { TRANSITIONS } from './workflow';
import {
  transitionConsequences,
  transitionQuestion,
  transitionRequest,
  transitionSummary,
  type TransitionSubject,
} from './transitions';

/**
 * The words a confirmation dialog shows.
 *
 * Worth testing as a table because the whole point of the dialog is that it
 * says something true and specific. A sentence that is merely plausible --
 * "Sulthan will be notified" when Sulthan is the one clicking -- is the
 * failure these tests are for.
 */

const RAHUL = { id: 'rahul', name: 'Rahul' };
const SULTHAN = { id: 'sulthan', name: 'Sulthan' };

/** A lead looking at Rahul's task, with Sulthan down as the reviewer. */
const lead: TransitionSubject = {
  actorId: 'lead',
  assignee: RAHUL,
  reviewer: SULTHAN,
  progress: 60,
};

function say(from: TaskStatus, to: TaskStatus, subject: TransitionSubject = lead): string {
  return transitionConsequences(from, to, subject).effects.join(' ');
}

describe('what the dialog says will happen', () => {
  it('names the reviewer who is about to be waiting', () => {
    expect(say('IN_PROGRESS', 'READY_FOR_REVIEW')).toContain(
      'Sulthan (reviewer) will be notified.',
    );
  });

  it('says the team lead gets it when no reviewer is named', () => {
    const text = say('IN_PROGRESS', 'READY_FOR_REVIEW', { ...lead, reviewer: null });
    expect(text).toContain('No reviewer is named, so the team lead will be notified.');
  });

  it('does not tell somebody they will be notified of their own action', () => {
    // Sulthan is the reviewer and is submitting it himself.
    const text = say('IN_PROGRESS', 'READY_FOR_REVIEW', { ...lead, actorId: SULTHAN.id });
    expect(text).not.toContain('Sulthan (reviewer) will be notified');
    expect(text).toContain('You are the reviewer');
  });

  it('spells out what leaving the board costs', () => {
    expect(say('ASSIGNED', 'BACKLOG')).toContain('’s My Tasks and stops counting as active.');
    expect(say('ASSIGNED', 'BACKLOG')).toContain('Rahul');
  });

  it('says approving sets progress to 100', () => {
    expect(say('IN_REVIEW', 'COMPLETED')).toContain(
      'Marks it Completed and sets progress to 100%.',
    );
  });

  it('says reopening notifies the assignee, and what it costs in progress', () => {
    const finished: TransitionSubject = { ...lead, progress: 100 };
    const text = say('COMPLETED', 'IN_PROGRESS', finished);

    expect(text).toContain('Moves it back to In progress and notifies');
    expect(text).toContain('Rahul');
    /*
     * transitionEffects drops a reopened task from 100 to 90, and the dialog
     * is the only chance anybody has to know that before it happens.
     */
    expect(text).toContain('Progress drops from 100% to 90%');
  });

  it('says resuming stops the blocked clock', () => {
    expect(say('BLOCKED', 'IN_PROGRESS')).toContain(
      'Clears the blocker and stops counting blocked time.',
    );
  });

  it('says starting is where cycle time begins', () => {
    expect(say('ASSIGNED', 'IN_PROGRESS')).toContain('Cycle time is counted from now.');
  });

  it('says who a task goes back to', () => {
    expect(say('IN_PROGRESS', 'ASSIGNED')).toContain('It goes back to Rahul to pick up again.');
  });

  it('says cancelling is the end of it', () => {
    expect(say('ASSIGNED', 'CANCELLED')).toContain('Cancelling is the end of the task.');
  });

  it('has something to say about every transition in the table', () => {
    for (const [from, rules] of Object.entries(TRANSITIONS)) {
      for (const rule of rules) {
        const result = transitionConsequences(from as TaskStatus, rule.to, lead);

        expect(result.effects.length, from + ' to ' + rule.to + ' says nothing').toBeGreaterThan(0);
        for (const effect of result.effects) {
          expect(effect.trim(), from + ' to ' + rule.to + ' has an empty sentence').not.toBe('');
        }
        // The button is named by the workflow table, never invented here.
        expect(result.verb).toBe(rule.label);
      }
    }
  });
});

describe('the progress warning', () => {
  it('warns when work is submitted unfinished, and says how unfinished', () => {
    const result = transitionConsequences('IN_PROGRESS', 'READY_FOR_REVIEW', lead);
    expect(result.warning).toBe('Progress is 60%. Submit anyway?');
  });

  it('does not warn at 100', () => {
    const result = transitionConsequences('IN_PROGRESS', 'READY_FOR_REVIEW', {
      ...lead,
      progress: 100,
    });
    expect(result.warning).toBeNull();
  });

  it('warns at 0 as well, which is the case worth catching', () => {
    const result = transitionConsequences('IN_PROGRESS', 'READY_FOR_REVIEW', {
      ...lead,
      progress: 0,
    });
    expect(result.warning).toBe('Progress is 0%. Submit anyway?');
  });

  it('is a caution and not a refusal', () => {
    // Nothing about the warning stops the move; that is the difference
    // between it and a required field.
    const result = transitionConsequences('IN_PROGRESS', 'READY_FOR_REVIEW', lead);
    expect(result.requires).toEqual([]);
  });
});

describe('the optional comment', () => {
  it('is offered for submitting and for approving', () => {
    expect(transitionConsequences('IN_PROGRESS', 'READY_FOR_REVIEW', lead).offersComment).toBe(
      true,
    );
    expect(transitionConsequences('IN_REVIEW', 'COMPLETED', lead).offersComment).toBe(true);
  });

  it('is not offered where a comment is already required', () => {
    // Asking twice for the same thing in one dialog.
    const changes = transitionConsequences('IN_REVIEW', 'CHANGES_REQUESTED', lead);
    expect(changes.requires).toContain('comment');
    expect(changes.offersComment).toBe(false);
  });

  it('is not offered for a plain move nobody needs to explain', () => {
    expect(transitionConsequences('ASSIGNED', 'IN_PROGRESS', lead).offersComment).toBe(false);
  });
});

describe('the request body', () => {
  it('carries the status that was on screen, so a stale confirmation is refused', () => {
    expect(transitionRequest({ to: 'IN_PROGRESS', expectedStatus: 'ASSIGNED' })).toEqual({
      to: 'IN_PROGRESS',
      expectedStatus: 'ASSIGNED',
    });
  });

  it('includes the comment when one was typed', () => {
    const body = transitionRequest({
      to: 'READY_FOR_REVIEW',
      expectedStatus: 'IN_PROGRESS',
      comment: 'Ready for a look, the migration is in a separate commit.',
    });

    expect(body).toEqual({
      to: 'READY_FOR_REVIEW',
      expectedStatus: 'IN_PROGRESS',
      comment: 'Ready for a look, the migration is in a separate commit.',
    });
  });

  it('trims the comment, and leaves out one that is only whitespace', () => {
    expect(
      transitionRequest({
        to: 'COMPLETED',
        expectedStatus: 'IN_REVIEW',
        comment: '  Looks good  ',
      }),
    ).toMatchObject({ comment: 'Looks good' });

    // The schema refuses an empty string, so it must not be sent at all.
    expect(
      transitionRequest({ to: 'COMPLETED', expectedStatus: 'IN_REVIEW', comment: '   ' }),
    ).not.toHaveProperty('comment');
  });

  it('sends the blocker type with the reason, since neither is valid alone', () => {
    const body = transitionRequest({
      to: 'BLOCKED',
      expectedStatus: 'IN_PROGRESS',
      blockedReason: 'Waiting on the client to confirm the opening balances',
      blockerType: 'WAITING_ON_CLIENT',
    });

    expect(body).toMatchObject({
      blockedReason: 'Waiting on the client to confirm the opening balances',
      blockerType: 'WAITING_ON_CLIENT',
    });
  });
});

describe('the title and the summary line', () => {
  it('puts the task key inside the verb where there is a preposition for it', () => {
    expect(transitionQuestion('Submit for review', 'ERP-12')).toBe('Submit ERP-12 for review?');
    expect(transitionQuestion('Move to backlog', 'ERP-12')).toBe('Move ERP-12 to backlog?');
    // The key is the object of the sentence, so it comes before the particle.
    expect(transitionQuestion('Move back to assigned', 'ERP-12')).toBe(
      'Move ERP-12 back to assigned?',
    );
    expect(transitionQuestion('Withdraw from review', 'ERP-12')).toBe(
      'Withdraw ERP-12 from review?',
    );
    expect(transitionQuestion('Reopen as assigned', 'ERP-12')).toBe('Reopen ERP-12 as assigned?');
  });

  it('puts it after the verb otherwise', () => {
    expect(transitionQuestion('Start', 'ERP-12')).toBe('Start ERP-12?');
    expect(transitionQuestion('Approve', 'ERP-12')).toBe('Approve ERP-12?');
    expect(transitionQuestion('Resume', 'ERP-12')).toBe('Resume ERP-12?');
  });

  it('hangs the key off the end of a verb that already has an object', () => {
    // "Start review ERP-12?" is not a sentence.
    expect(transitionQuestion('Start review', 'ERP-12')).toBe('Start review on ERP-12?');
    expect(transitionQuestion('Request changes', 'ERP-12')).toBe('Request changes on ERP-12?');
    expect(transitionQuestion('Resume work', 'ERP-12')).toBe('Resume work on ERP-12?');
  });

  it('asks a readable question for every label in the table', () => {
    for (const rules of Object.values(TRANSITIONS)) {
      for (const rule of rules) {
        const question = transitionQuestion(rule.label, 'ERP-12');

        expect(question, rule.label).toContain('ERP-12');
        expect(question, rule.label).toMatch(/\?$/);
        // No doubled spaces from a missing part of the pattern.
        expect(question, rule.label).not.toMatch(/ {2}/);
      }
    }
  });

  it('names both ends of the move in readable words', () => {
    expect(transitionSummary('IN_PROGRESS', 'READY_FOR_REVIEW')).toBe(
      'From In progress to Ready for review',
    );
  });
});
