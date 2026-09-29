import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card, Spinner } from './primitives';

/**
 * Asks before doing something that cannot be undone.
 *
 * Used for every destructive action, so they all behave the same way: Escape
 * and the backdrop cancel, focus lands on Cancel rather than the dangerous
 * button, and the confirm button says what it will do rather than "OK".
 */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  /** The verb, e.g. "Deactivate". Never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  error?: string | null;
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    // Focus the safe option, not the destructive one.
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <Card className="w-full max-w-md p-5">
        <h2 className="text-sm font-semibold">{title}</h2>

        {description ? <div className="mt-2 text-sm text-ink-muted">{description}</div> : null}

        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-action"
          >
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/**
 * Wiring for the common case: one dialog, one pending subject.
 *
 * Keeps each page from re-inventing the open/target/busy state that every
 * destructive action needs.
 */
export function useConfirm<T>() {
  const [target, setTarget] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return {
    target,
    busy,
    error,
    open: target !== null,
    ask: (subject: T) => {
      setError(null);
      setTarget(subject);
    },
    cancel: () => {
      setTarget(null);
      setError(null);
    },
    async run(action: (subject: T) => Promise<unknown>) {
      if (target === null) return;
      setBusy(true);
      setError(null);
      try {
        await action(target);
        setTarget(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'That did not work.');
      } finally {
        setBusy(false);
      }
    },
  };
}
