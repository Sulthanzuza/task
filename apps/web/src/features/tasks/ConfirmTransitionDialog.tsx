import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { TaskStatus } from '@tm/shared';
import {
  BLOCKER_TYPES,
  BLOCKER_TYPE_LABELS,
  transitionConsequences,
  transitionQuestion,
  transitionSummary,
  type TransitionPerson,
} from '@tm/shared';
import { StatusBadge } from '@/components/common/badges';
import { Button, Card, Label, Select, Spinner, Textarea } from '@/components/ui/primitives';

/**
 * Confirms a status change, and says what the change will do.
 *
 * One dialog for every transition from every entry point — the detail page,
 * the board, My Tasks — so a drag onto Blocked and a click on Block ask for
 * exactly the same things. Transitions that need a reason or a comment ask
 * for it here too rather than in a second dialog on top of this one: the
 * reason box *is* the confirmation, and stacking two would mean clicking
 * through the same decision twice.
 *
 * The sentences come from the shared workflow table, not from this file, so a
 * rule change cannot leave the dialog describing the old behaviour.
 */
export function ConfirmTransitionDialog({
  task,
  to,
  actorId,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  task: {
    key: string;
    title: string;
    status: TaskStatus;
    progress: number;
    assignee?: TransitionPerson | null;
    reviewer?: TransitionPerson | null;
  };
  to: TaskStatus;
  actorId: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (values: { comment?: string; blockedReason?: string; blockerType?: string }) => void;
}) {
  const [comment, setComment] = useState('');
  const [blockedReason, setBlockedReason] = useState('');
  const [blockerType, setBlockerType] = useState<string>('DEPENDENCY');

  const cancelRef = useRef<HTMLButtonElement>(null);
  const firstFieldRef = useRef<HTMLTextAreaElement>(null);

  const consequences = transitionConsequences(task.status, to, {
    actorId,
    assignee: task.assignee ?? null,
    reviewer: task.reviewer ?? null,
    progress: task.progress,
  });

  const needsComment = consequences.requires.includes('comment');
  const needsBlocker = consequences.requires.includes('blockedReason');
  const ready =
    (!needsComment || comment.trim().length > 0) &&
    (!needsBlocker || blockedReason.trim().length > 2);

  /*
   * Cancel takes the focus, so the safe answer is the one a stray Return
   * reaches. Where the dialog has a field that must be filled in, the field
   * takes it instead: focusing Cancel on a dialog that cannot be confirmed
   * without typing just means tabbing back.
   */
  useEffect(() => {
    if (needsComment || needsBlocker) firstFieldRef.current?.focus();
    else cancelRef.current?.focus();
  }, [needsComment, needsBlocker]);

  // Escape cancels, wherever the focus happens to be.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (!busy) onCancel();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  const send = () =>
    onConfirm({
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      ...(needsBlocker ? { blockedReason: blockedReason.trim(), blockerType } : {}),
    });

  const destructive = to === 'CANCELLED';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      /*
       * A click on the backdrop cancels. The check for the target being the
       * backdrop itself matters: without it, releasing a drag that started
       * inside the card would close the dialog.
       */
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-transition-title"
        className="w-full max-w-md p-5"
      >
        <h2 id="confirm-transition-title" className="text-sm font-semibold">
          {transitionQuestion(consequences.verb, task.key)}
        </h2>
        <p className="mt-1 truncate text-xs text-ink-muted" title={task.title}>
          {task.title}
        </p>

        {/* Both ends of the move, so there is no doubt which way it goes. */}
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
          <span className="sr-only">{transitionSummary(task.status, to)}</span>
          <span aria-hidden className="flex flex-wrap items-center gap-1.5">
            From <StatusBadge status={task.status} /> to <StatusBadge status={to} />
          </span>
        </p>

        {consequences.effects.length > 0 ? (
          <ul className="mt-3 space-y-1 text-xs text-ink-muted">
            {consequences.effects.map((effect) => (
              <li key={effect} className="flex gap-1.5">
                <span aria-hidden className="text-ink-faint">
                  ·
                </span>
                {effect}
              </li>
            ))}
          </ul>
        ) : null}

        {consequences.warning ? (
          <p className="mt-3 flex items-start gap-1.5 rounded-md bg-warning-soft px-2.5 py-2 text-xs text-warning">
            <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0" />
            {consequences.warning}
          </p>
        ) : null}

        {needsBlocker ? (
          <div className="mt-4 space-y-3">
            <div>
              <Label htmlFor="blockerType">What kind of blocker?</Label>
              <Select
                id="blockerType"
                value={blockerType}
                onChange={(e) => setBlockerType(e.currentTarget.value)}
              >
                {BLOCKER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {BLOCKER_TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="blockedReason">What is it waiting on?</Label>
              <Textarea
                id="blockedReason"
                ref={firstFieldRef}
                value={blockedReason}
                onChange={(e) => setBlockedReason(e.currentTarget.value)}
                placeholder="Waiting on the warehouse team to confirm the opening balances"
              />
            </div>
          </div>
        ) : null}

        {needsComment ? (
          <div className="mt-4">
            <Label htmlFor="comment">Explain the change</Label>
            <Textarea
              id="comment"
              ref={needsBlocker ? undefined : firstFieldRef}
              value={comment}
              onChange={(e) => setComment(e.currentTarget.value)}
              placeholder="Please add a regression test before resubmitting."
            />
          </div>
        ) : null}

        {consequences.offersComment ? (
          <div className="mt-4">
            <Label htmlFor="comment">Add a comment (optional)</Label>
            <Textarea
              id="comment"
              value={comment}
              onChange={(e) => setComment(e.currentTarget.value)}
              placeholder="Anything the next person should know."
            />
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>
            {destructive ? 'Keep it open' : 'Cancel'}
          </Button>
          <Button
            /*
             * Cancelling a task is the one move with nothing after it, so the
             * button that does it is styled as what it is.
             */
            variant={destructive ? 'danger' : 'primary'}
            // Disabled while sending, so a second click cannot send it twice.
            disabled={!ready || busy}
            onClick={send}
          >
            {busy ? <Spinner /> : null}
            {consequences.verb}
          </Button>
        </div>
      </Card>
    </div>
  );
}
