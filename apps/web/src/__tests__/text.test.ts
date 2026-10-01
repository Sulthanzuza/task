import { describe, expect, it } from 'vitest';
import { ACTIVITY_ACTIONS, type ActivityAction } from '@tm/shared';
import { describeActivity } from '@/features/tasks/activityText';
import { relativeTime } from '@/lib/utils';

/**
 * The words the product says about time and about history.
 *
 * Both of these reached a screenshot before anyone noticed: a timeline row
 * reading "Sulthan attachment.created", and a comment posted an hour ago
 * labelled "in 4 hours".
 */

// ---------------------------------------------------------------------------
// Activity sentences
// ---------------------------------------------------------------------------

function entryFor(action: ActivityAction) {
  return {
    kind: 'activity' as const,
    id: '00000000-0000-0000-0000-000000000001',
    actor: {
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Sulthan',
      email: 'sulthan@example.com',
      role: 'TEAM_LEAD' as const,
      avatarUrl: null,
      isActive: true,
    },
    action,
    field: 'priority',
    oldValue: action === 'task.transitioned' ? 'BACKLOG' : 10,
    newValue:
      action === 'task.transitioned'
        ? 'IN_PROGRESS'
        : action.startsWith('attachment')
          ? { fileName: 'opening-balances.png', mimeType: 'image/png' }
          : 40,
    meta: null,
    createdAt: '2026-10-01T04:00:00.000Z',
  };
}

describe('activity sentences', () => {
  it('has words for every action in the shared list', () => {
    /*
     * The switch is exhaustive, so a missing case is a type error. This walks
     * the list at runtime too, in case the type is ever widened back to
     * string: that is how the raw action names reached the screen.
     */
    const bare = ACTIVITY_ACTIONS.filter((action) => {
      // A comment renders itself; its activity row is deliberately silent.
      if (action === 'comment.created') return false;
      const sentence = describeActivity(entryFor(action));
      return sentence.length === 0 || sentence.includes(action);
    });

    expect(bare, 'these actions print their own name at the reader').toEqual([]);
  });

  it('names the file an attachment event is about', () => {
    expect(describeActivity(entryFor('attachment.created'))).toBe(
      'Sulthan attached opening-balances.png',
    );
  });

  it('falls back to "a file" when the name was not recorded', () => {
    const entry = { ...entryFor('attachment.created'), newValue: null };
    expect(describeActivity(entry)).toBe('Sulthan attached a file');
  });

  it('reads a transition as the two statuses it went between', () => {
    expect(describeActivity(entryFor('task.transitioned'))).toBe(
      'Sulthan moved it from Backlog to In progress',
    );
  });

  it('says the system did it when there is no actor', () => {
    const entry = { ...entryFor('task.created'), actor: null };
    expect(describeActivity(entry)).toBe('The system created this task');
  });
});

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
  const now = new Date('2026-10-01T13:00:00.000Z');

  it('reads as the past for something that happened', () => {
    expect(relativeTime('2026-10-01T11:00:00.000Z', now)).toContain('ago');
  });

  it('never says "in X" for a moment a few minutes ahead of the clock', () => {
    /*
     * The server's clock and the browser's are different clocks. A device a
     * few minutes slow would otherwise label a comment it has just posted
     * "in 4 minutes".
     */
    for (const minutes of [0.5, 1, 4, 5]) {
      const ahead = new Date(now.getTime() + minutes * 60_000).toISOString();
      expect(relativeTime(ahead, now), minutes + ' minutes ahead').toBe('just now');
    }
  });

  it('still phrases a genuine future date as the future', () => {
    const tomorrow = new Date(now.getTime() + 24 * 3_600_000).toISOString();
    expect(relativeTime(tomorrow, now)).toMatch(/in |tomorrow/i);
  });

  it('says never for a missing or unreadable value', () => {
    expect(relativeTime(null, now)).toBe('never');
    expect(relativeTime(undefined, now)).toBe('never');
    expect(relativeTime('not a date', now)).toBe('never');
  });
});
