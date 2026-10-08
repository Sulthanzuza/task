import type { TaskStatus } from './enums';
import { STATUS_LABELS } from './enums';
import { findRule, transitionEffects, type TransitionRequirement } from './workflow';

/**
 * What a status change will actually do, in words.
 *
 * A confirmation is only worth clicking through if it says something the
 * button did not already say. "Are you sure?" is not that; "it leaves Rahul's
 * My Tasks and stops counting as active" is. So the copy is derived here from
 * the same workflow table the server validates against, and from
 * transitionEffects, which is what really changes the row — rather than
 * written out per button in the UI, where it would drift the first time a
 * rule changed.
 *
 * Everything here is a pure function of the task and the actor, so the whole
 * set of sentences can be read as a table in the tests.
 */

export interface TransitionPerson {
  id: string;
  name: string;
}

export interface TransitionSubject {
  /** Who is making the change. Nobody is ever notified of their own action. */
  actorId: string;
  assignee?: TransitionPerson | null;
  reviewer?: TransitionPerson | null;
  progress: number;
}

export interface TransitionConsequences {
  /** One sentence per thing that will happen. */
  effects: string[];
  /** A caution worth reading, which never blocks the change. */
  warning: string | null;
  /**
   * Whether to offer an optional comment box. Transitions that *require* a
   * comment ask for it as a field, not as an extra.
   */
  offersComment: boolean;
  /** What the confirming button says, taken from the workflow table. */
  verb: string;
  requires: TransitionRequirement[];
}

/** The people this change will notify, excluding whoever is making it. */
function notifiedBy(subject: TransitionSubject): TransitionPerson[] {
  const people: TransitionPerson[] = [];

  for (const person of [subject.assignee, subject.reviewer]) {
    if (!person) continue;
    // The API never notifies the actor of their own action, so neither does
    // the sentence describing it.
    if (person.id === subject.actorId) continue;
    if (people.some((already) => already.id === person.id)) continue;
    people.push(person);
  }

  return people;
}

function listNames(people: TransitionPerson[]): string {
  const names = people.map((person) => person.name);
  if (names.length <= 1) return names[0] ?? '';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/** Possessive of a name. The one case worth handling is a name ending in s. */
function possessive(name: string): string {
  return name.endsWith('s') ? name + '’' : name + '’s';
}

function willBeNotified(people: TransitionPerson[]): string[] {
  return people.length > 0 ? [listNames(people) + ' will be notified.'] : [];
}

export function transitionConsequences(
  from: TaskStatus,
  to: TaskStatus,
  subject: TransitionSubject,
): TransitionConsequences {
  const rule = findRule(from, to);
  const requires = rule?.requires ? [...rule.requires] : [];
  const effects: string[] = [];
  let warning: string | null = null;

  const notified = notifiedBy(subject);
  const assignee = subject.assignee;

  switch (to) {
    case 'READY_FOR_REVIEW': {
      /*
       * Submitting is aimed at one person, and who that is depends on whether
       * a reviewer was ever named: the API falls back to the team lead, so the
       * dialog says so rather than leaving it to be discovered afterwards.
       */
      const reviewer = subject.reviewer;
      if (reviewer && reviewer.id !== subject.actorId) {
        effects.push(reviewer.name + ' (reviewer) will be notified.');
      } else if (reviewer) {
        effects.push('You are the reviewer, so nobody else is waiting on this.');
      } else {
        effects.push('No reviewer is named, so the team lead will be notified.');
      }

      if (subject.progress < 100) {
        warning = 'Progress is ' + String(subject.progress) + '%. Submit anyway?';
      }
      break;
    }

    case 'COMPLETED':
      effects.push('Marks it Completed and sets progress to 100%.');
      effects.push(...willBeNotified(notified));
      break;

    case 'BACKLOG':
      effects.push(
        assignee
          ? 'It leaves ' + possessive(assignee.name) + ' My Tasks and stops counting as active.'
          : 'It stops counting as active.',
      );
      effects.push(...willBeNotified(notified));
      break;

    case 'IN_PROGRESS':
      if (from === 'COMPLETED') {
        effects.push(
          notified.length > 0
            ? 'Moves it back to In progress and notifies ' + listNames(notified) + '.'
            : 'Moves it back to In progress.',
        );
      } else if (from === 'BLOCKED') {
        effects.push('Clears the blocker and stops counting blocked time.');
        effects.push(...willBeNotified(notified));
      } else if (from === 'ASSIGNED') {
        effects.push('Marks it In progress. Cycle time is counted from now.');
        effects.push(...willBeNotified(notified));
      } else if (from === 'READY_FOR_REVIEW' || from === 'IN_REVIEW') {
        effects.push('Takes it out of the review queue and back to In progress.');
        effects.push(...willBeNotified(notified));
      } else {
        effects.push('Moves it back to In progress.');
        effects.push(...willBeNotified(notified));
      }
      break;

    case 'ASSIGNED':
      effects.push(
        assignee
          ? 'It goes back to ' + assignee.name + ' to pick up again.'
          : 'It waits for somebody to be assigned.',
      );
      effects.push(...willBeNotified(notified));
      break;

    case 'IN_REVIEW':
      effects.push('Marks it In review, so it is clear somebody has picked it up.');
      effects.push(...willBeNotified(notified));
      break;

    case 'BLOCKED':
      effects.push('Blocked time starts counting from now, in working hours.');
      effects.push(...willBeNotified(notified));
      break;

    case 'CHANGES_REQUESTED':
      effects.push(
        assignee
          ? 'It goes back to ' + assignee.name + ', with your comment as the reason.'
          : 'It goes back for changes, with your comment as the reason.',
      );
      break;

    case 'CANCELLED':
      effects.push('Cancelling is the end of the task. It stops counting in every total.');
      effects.push(...willBeNotified(notified));
      break;
  }

  /*
   * Progress is not something the person asked to change, so when the move
   * changes it anyway the dialog says so. transitionEffects is the authority
   * here: reading it means the sentence cannot disagree with the row. The
   * Completed case is left out because its own sentence already says 100%.
   */
  const applied = transitionEffects(from, to, new Date(), subject.progress);
  if (
    applied.progress !== undefined &&
    applied.progress !== subject.progress &&
    to !== 'COMPLETED'
  ) {
    effects.push(
      'Progress drops from ' +
        String(subject.progress) +
        '% to ' +
        String(applied.progress) +
        '%, because it is not finished any more.',
    );
  }

  return {
    effects,
    warning,
    /*
     * An optional note belongs where somebody is likely to want to explain
     * themselves to the next person: handing work on for review, and signing
     * it off. Everywhere else it is a box nobody fills in.
     */
    offersComment: requires.length === 0 && (to === 'READY_FOR_REVIEW' || to === 'COMPLETED'),
    verb: rule?.label ?? 'Confirm',
    requires,
  };
}

/**
 * The title: "Submit ERP-12 for review?" rather than "Are you sure?".
 *
 * The verb comes from the workflow table, where it is written to sit on a
 * button ("Submit for review"), so the key goes inside it where there is a
 * preposition to put it in front of.
 */
export function transitionQuestion(verb: string, taskKey: string): string {
  /*
   * The key goes where the object of the sentence belongs, which is right
   * after the verb and before any particle: "Move ERP-12 back to assigned?",
   * not "Move back ERP-12 to assigned?".
   */
  const phrase = /^(\w+)( back| again)? (for|to|from|as) (.*)$/.exec(verb);
  if (phrase) {
    const [, head, particle, preposition, rest] = phrase;
    return head + ' ' + taskKey + (particle ?? '') + ' ' + preposition + ' ' + rest + '?';
  }

  // A verb with its own object -- "Start review", "Request changes" -- takes
  // the key on the end instead, where there is nowhere to put it inside.
  if (verb.includes(' ')) {
    return verb + ' on ' + taskKey + '?';
  }

  return verb + ' ' + taskKey + '?';
}

/** The line that names both ends of the move. */
export function transitionSummary(from: TaskStatus, to: TaskStatus): string {
  return 'From ' + STATUS_LABELS[from] + ' to ' + STATUS_LABELS[to];
}

export interface TransitionRequestInput {
  to: TaskStatus;
  /**
   * The status the person was looking at when they confirmed. The server
   * refuses the change if the task has moved since, so a confirmation always
   * applies to the move it actually described.
   */
  expectedStatus: TaskStatus;
  comment?: string;
  blockedReason?: string;
  blockerType?: string;
}

/**
 * The body to send. Blank optional fields are left out rather than sent as
 * empty strings, which the schema would refuse.
 */
export function transitionRequest(input: TransitionRequestInput): Record<string, unknown> {
  const body: Record<string, unknown> = { to: input.to, expectedStatus: input.expectedStatus };

  const comment = input.comment?.trim();
  if (comment) body.comment = comment;

  const reason = input.blockedReason?.trim();
  if (reason) {
    body.blockedReason = reason;
    body.blockerType = input.blockerType;
  }

  return body;
}
