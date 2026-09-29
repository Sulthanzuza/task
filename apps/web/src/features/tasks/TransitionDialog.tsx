import { useState } from 'react';
import type { TaskStatus, TransitionRequirement } from '@tm/shared';
import { BLOCKER_TYPES, BLOCKER_TYPE_LABELS, STATUS_LABELS } from '@tm/shared';
import { Button, Card, Label, Select, Spinner, Textarea } from '@/components/ui/primitives';

/**
 * Asks for whatever a transition requires before it is sent.
 *
 * Shared by the task detail page and the board, so a drag onto Blocked and a
 * click on Block collect exactly the same information, and Confirm stays
 * disabled until the workflow's requirements are actually met.
 */
export function TransitionDialog({
  to,
  requires,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  to: TaskStatus;
  requires: TransitionRequirement[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (values: Record<string, unknown>) => void;
}) {
  const [comment, setComment] = useState('');
  const [blockedReason, setBlockedReason] = useState('');
  const [blockerType, setBlockerType] = useState<string>('DEPENDENCY');

  const needsComment = requires.includes('comment');
  const needsBlocker = requires.includes('blockedReason');
  const ready = (!needsComment || comment.trim().length > 0) && (!needsBlocker || blockedReason.trim().length > 2);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={'Move to ' + STATUS_LABELS[to]}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <Card className="w-full max-w-md p-5">
        <h2 className="text-sm font-semibold">Move to {STATUS_LABELS[to]}</h2>

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
                autoFocus
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
              autoFocus={!needsBlocker}
              value={comment}
              onChange={(e) => setComment(e.currentTarget.value)}
              placeholder="Please add a regression test before resubmitting."
            />
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={!ready || busy}
            onClick={() =>
              onConfirm({
                ...(needsComment ? { comment: comment.trim() } : {}),
                ...(needsBlocker ? { blockedReason: blockedReason.trim(), blockerType } : {}),
              })
            }
          >
            {busy ? <Spinner /> : null}
            Confirm
          </Button>
        </div>
      </Card>
    </div>
  );
}
