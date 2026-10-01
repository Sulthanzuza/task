import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Eye, EyeOff, Plus, X } from 'lucide-react';
import type { TaskDetail, TaskStatus, TimelineEntry, TransitionRequirement } from '@tm/shared';
import { STATUS_LABELS, statusColor } from '@tm/shared';
import {
  isPendingComment,
  useAddComment,
  useAssignTask,
  useSetLabels,
  useTask,
  useTaskTimeline,
  useTransitionTask,
  useUpdateProgress,
  useUpdateTask,
  useWatchToggle,
} from './api';
import { useLabels, useUsers } from '@/features/team/api';
import { Markdown } from '@/components/common/Markdown';
import { RingGauge } from '@/components/charts';
import { Attachments } from './Attachments';
import { CommentBody, MentionBox } from './MentionBox';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';
import {
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Select,
  Skeleton,
  Spinner,
  Textarea,
} from '@/components/ui/primitives';
import {
  BlockerBadge,
  DueBadge,
  LabelChip,
  PriorityBadge,
  StatusBadge,
  UserAvatar,
} from '@/components/common/badges';
import { formatDate, formatDateTime, formatHours, relativeTime } from '@/lib/utils';
import { TransitionDialog } from './TransitionDialog';
import { PersonPicker } from './PersonPicker';

export function TaskDetailPage() {
  const { key } = useParams<{ key: string }>();
  const task = useTask(key);
  const timeline = useTaskTimeline(key);

  if (task.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (task.isError) {
    const error = task.error as ApiError;
    const gone = error.status === 404 || error.status === 403;

    /*
     * A notification or an old link can outlive the task it points at, or the
     * person's access to it. That is an ordinary thing to happen, not a fault,
     * so it reads as an explanation rather than an error page.
     */
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <Card>
          <EmptyState
            title={gone ? 'This task is no longer available' : 'Could not open this task'}
            description={
              gone
                ? 'It may have been deleted, or moved to a team you are not part of. Nothing is wrong with your account.'
                : error.message
            }
            action={
              <div className="flex gap-2">
                <Button variant="outline" asChild>
                  <Link to="/tasks">Back to the task list</Link>
                </Button>
                <Button variant="ghost" asChild>
                  <Link to="/notifications">Notifications</Link>
                </Button>
              </div>
            }
          />
        </Card>
      </div>
    );
  }

  if (!task.data) return null;

  return (
    /*
     * pb-28 clears the sticky action bar on a phone. Without it the bar sits
     * on top of the Comment button, which is the one thing at the bottom of
     * this page somebody needs to press.
     */
    <div className="mx-auto max-w-6xl px-4 py-6 pb-28 sm:px-6 md:pb-6">
      {/*
        One column on a phone, and the order is the order you need it in:
        what this is, what you can do about it, the facts, then the detail.
        On a wide screen the facts move into their own column, so `order`
        only applies while everything is stacked.
      */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="contents lg:col-span-2 lg:block lg:space-y-5">
          <div className="order-1 lg:mb-5">
            <TaskHeader task={task.data} />
          </div>
          <div className="order-2 lg:mb-5">
            <TransitionBar task={task.data} />
          </div>
          <div className="order-4 lg:mb-5">
            <DescriptionCard task={task.data} />
          </div>
          <div className="order-5 lg:mb-5">
            <AttachmentsSection task={task.data} />
          </div>
          <div className="order-6">
            <TimelineCard
              taskKey={key}
              entries={timeline.data?.items}
              loading={timeline.isLoading}
            />
          </div>
        </div>

        <aside className="order-3 space-y-4">
          <FieldsCard task={task.data} />
        </aside>
      </div>
    </div>
  );
}

/**
 * Attachments, with the same rules the API applies.
 *
 * Anyone who can comment can attach; a lead may remove anybody's file, while
 * everyone else may remove only their own. Getting this wrong in the browser
 * would only offer a button that fails, but an offered button that fails is
 * still a lie about what somebody may do.
 */
function AttachmentsSection({ task }: { task: TaskDetail }) {
  const { user, isAdmin } = useAuth();

  const involved =
    user !== null &&
    (task.assignee?.id === user.id ||
      task.reviewer?.id === user.id ||
      task.createdBy.id === user.id ||
      task.watcherIds.includes(user.id));

  const lead = user?.role === 'TEAM_LEAD' || isAdmin;

  return <Attachments taskIdOrKey={task.key} canAttach={lead || involved} canDeleteAny={lead} />;
}

function TaskHeader({ task }: { task: TaskDetail }) {
  const { user } = useAuth();
  const watching = user ? task.watcherIds.includes(user.id) : false;
  const toggle = useWatchToggle(task.id);

  return (
    <header>
      <div className="flex items-center gap-2 text-xs text-ink-faint">
        <Link to={'/tasks?projectId=' + task.projectId} className="hover:underline">
          {task.projectKey}
        </Link>
        <span aria-hidden>/</span>
        <span className="font-mono">{task.key}</span>

        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => toggle.mutate(watching)}
          disabled={toggle.isPending}
        >
          {watching ? <EyeOff size={14} /> : <Eye size={14} />}
          {watching ? 'Stop watching' : 'Watch'}
        </Button>
      </div>

      <h1 className="mt-1 text-xl font-semibold tracking-tight">{task.title}</h1>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <StatusBadge status={task.status} />
        <PriorityBadge priority={task.priority} />
        <DueBadge dueDate={task.dueDate} status={task.status} emptyLabel="No due date" />
        {task.labels.map((label) => (
          <LabelChip key={label.id} name={label.name} color={label.color} />
        ))}
      </div>

      {task.status === 'BLOCKED' && task.blockedReason ? (
        <div className="mt-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <BlockerBadge type={task.blockerType} />
            <span className="text-xs text-danger">
              Blocked {task.blockedAt ? relativeTime(task.blockedAt) : ''}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-ink">{task.blockedReason}</p>
        </div>
      ) : null}
    </header>
  );
}

/**
 * Which of the allowed moves is the one somebody came here to make.
 *
 * The server says what is permitted; it has no opinion on what is likely.
 * Giving every option the same weight makes the person read all six, and
 * puts "Cancel the task" beside "Start work" as an equal.
 *
 * Forward is primary, cancelling is destructive and asks first, and the rest
 * are ordinary. The target status decides it, so a new label in the workflow
 * table does not need a change here.
 */
const RANK = { primary: 0, secondary: 1, danger: 2 } as const;

function emphasis(to: TaskStatus): 'primary' | 'danger' | 'secondary' {
  if (to === 'IN_PROGRESS' || to === 'READY_FOR_REVIEW' || to === 'COMPLETED') return 'primary';
  if (to === 'CANCELLED') return 'danger';
  return 'secondary';
}

/**
 * The buttons come from availableTransitions, which the server computed from the
 * same workflow table it will validate against. The UI never guesses what is allowed.
 */
function TransitionBar({ task }: { task: TaskDetail }) {
  const transition = useTransitionTask(task.id);
  const [pending, setPending] = useState<{
    to: TaskStatus;
    requires: TransitionRequirement[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (task.availableTransitions.length === 0) {
    return (
      <p className="text-xs text-ink-faint">
        You cannot move this task from {STATUS_LABELS[task.status]}.
      </p>
    );
  }

  const run = (to: TaskStatus, extra: Record<string, unknown> = {}) => {
    setError(null);
    transition.mutate({ to, ...extra } as Parameters<typeof transition.mutate>[0], {
      onSuccess: () => setPending(null),
      onError: (err) => setError(err instanceof ApiError ? err.message : 'That change failed.'),
    });
  };

  return (
    <div
      className={
        /*
         * On a phone the status actions follow you: by the time you have read
         * the description and the timeline, the buttons are far off screen,
         * and they are the reason most people opened the task.
         */
        'max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-30 max-md:border-t ' +
        'max-md:border-border-subtle max-md:bg-[var(--color-canvas)]/95 max-md:p-3 ' +
        'max-md:backdrop-blur-xl'
      }
    >
      <div className="flex flex-wrap gap-2">
        {[...task.availableTransitions]
          // Forward first, cancelling last, whatever order the server listed.
          .sort((a, b) => RANK[emphasis(a.to)] - RANK[emphasis(b.to)])
          .map((option) => {
            const weight = emphasis(option.to);
            return (
              <Button
                key={option.to}
                size="sm"
                variant={weight === 'secondary' ? 'outline' : weight}
                disabled={transition.isPending}
                onClick={() =>
                  option.requires.length > 0
                    ? setPending({ to: option.to, requires: option.requires })
                    : run(option.to)
                }
              >
                {option.label}
              </Button>
            );
          })}
      </div>

      {error && !pending ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}

      {pending ? (
        <TransitionDialog
          to={pending.to}
          requires={pending.requires}
          busy={transition.isPending}
          error={error}
          onCancel={() => {
            setPending(null);
            setError(null);
          }}
          onConfirm={(values) => run(pending.to, values)}
        />
      ) : null}
    </div>
  );
}

function DescriptionCard({ task }: { task: TaskDetail }) {
  return (
    <Card className="p-4">
      <h2 className="mb-2 text-xs font-semibold text-ink-muted">Description</h2>
      {task.description ? (
        <Markdown text={task.description} className="text-sm text-ink" />
      ) : (
        <p className="text-sm text-ink-faint">No description yet.</p>
      )}
    </Card>
  );
}

/**
 * Changing who is on a task, from the task itself.
 *
 * A lead may reassign; everybody else sees the name. The change shows at once
 * and goes back if the server refuses, which it will for anyone who is not a
 * lead of this team.
 */
function AssigneeField({ task }: { task: TaskDetail }) {
  const { isLead } = useAuth();
  const people = useUsers();
  const assign = useAssignTask(task.id, people.data?.items ?? []);
  const [handover, setHandover] = useState<{ id: string | null; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isLead) {
    return (
      <Field label="Assignee">
        <UserAvatar user={task.assignee} showName size="sm" />
      </Field>
    );
  }

  const send = (assigneeId: string | null, note?: string) => {
    setError(null);
    assign.mutate(
      { assigneeId, ...(note ? { handoverNote: note } : {}) },
      {
        onSuccess: () => setHandover(null),
        onError: (cause) => setError(cause instanceof Error ? cause.message : 'That did not work.'),
      },
    );
  };

  return (
    <div>
      <Field label="Assignee">
        <PersonPicker
          label="Assignee"
          className="w-48"
          value={task.assignee}
          disabled={assign.isPending}
          onChange={(id) => {
            if (id === task.assignee?.id) return;
            /*
             * Moving work from one person to another is a handover, and the
             * person picking it up needs to know where it got to. Taking it
             * off somebody, or giving out work nobody held, is not.
             */
            if (task.assignee && id !== null) {
              const next = people.data?.items.find((person) => person.id === id);
              setHandover({ id, name: next?.name ?? 'them' });
              return;
            }
            send(id);
          }}
        />
      </Field>

      {error ? (
        <p role="alert" className="mt-1 text-right text-xs text-danger">
          {error}
        </p>
      ) : null}

      {handover ? (
        <HandoverDialog
          from={task.assignee?.name ?? 'nobody'}
          to={handover.name}
          busy={assign.isPending}
          error={error}
          onCancel={() => {
            setHandover(null);
            setError(null);
          }}
          onConfirm={(note) => send(handover.id, note)}
        />
      ) : null}
    </div>
  );
}

/**
 * The note that travels with reassigned work.
 *
 * Optional, because sometimes there is genuinely nothing to say and forcing
 * a sentence only produces "reassigning". When there is something, it lands
 * on the timeline where the next person will actually look for it.
 */
function HandoverDialog({
  from,
  to,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  from: string;
  to: string;
  busy: boolean;
  error: string | null;
  onCancel(): void;
  onConfirm(note?: string): void;
}) {
  const [note, setNote] = useState('');
  const trimmed = note.trim();
  // The API will not take a note shorter than this, so neither will the form.
  const tooShort = trimmed.length > 0 && trimmed.length < 3;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={'Hand over to ' + to}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <Card className="w-full max-w-md p-5">
        <h2 className="text-sm font-semibold">
          Hand over from {from} to {to}
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          Anything {to} should know before picking this up? It goes on the timeline.
        </p>

        <div className="mt-3">
          <Label htmlFor="handover-note">Handover note</Label>
          <Textarea
            id="handover-note"
            autoFocus
            rows={4}
            value={note}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
              setNote(event.currentTarget.value)
            }
            placeholder="The API side is done and merged; the migration still needs reviewing."
          />
          {tooShort ? (
            <p role="alert" className="mt-1 text-xs text-danger">
              A note needs at least three characters, or leave it empty.
            </p>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || tooShort}
            onClick={() => onConfirm(trimmed.length >= 3 ? trimmed : undefined)}
          >
            {busy ? <Spinner /> : null}
            Hand it over
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** The reviewer goes through the same endpoint as the assignee. */
function ReviewerField({ task }: { task: TaskDetail }) {
  const { isLead } = useAuth();
  const people = useUsers();
  const assign = useAssignTask(task.id, people.data?.items ?? []);
  const [error, setError] = useState<string | null>(null);

  if (!isLead) {
    return (
      <Field label="Reviewer">
        {task.reviewer ? (
          <UserAvatar user={task.reviewer} showName size="sm" />
        ) : (
          <span className="text-xs text-ink-faint">Nobody yet</span>
        )}
      </Field>
    );
  }

  return (
    <div>
      <Field label="Reviewer">
        <PersonPicker
          label="Reviewer"
          className="w-48"
          nobodyLabel="Nobody yet"
          value={task.reviewer}
          disabled={assign.isPending}
          onChange={(id) => {
            if (id === (task.reviewer?.id ?? null)) return;
            setError(null);
            // assigneeId is required by the endpoint; send back what it has.
            assign.mutate(
              { assigneeId: task.assignee?.id ?? null, reviewerId: id },
              {
                onError: (cause) =>
                  setError(cause instanceof Error ? cause.message : 'That did not work.'),
              },
            );
          }}
        />
      </Field>
      {error ? (
        <p role="alert" className="mt-1 text-right text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A field a lead edits in place and everyone else reads.
 *
 * It commits on blur rather than on every keystroke, so a half-typed date is
 * never sent, and it holds a draft while focused so the server's value does
 * not overwrite what is being typed.
 */
function InlineEdit({
  label,
  value,
  display,
  type,
  step,
  min,
  placeholder,
  onCommit,
  busy,
}: {
  label: string;
  value: string;
  display: React.ReactNode;
  type: 'date' | 'number';
  step?: string;
  min?: string;
  placeholder?: string;
  onCommit(next: string): void;
  busy: boolean;
}) {
  const { isLead } = useAuth();
  const [draft, setDraft] = useState<string | null>(null);

  if (!isLead) return <Field label={label}>{display}</Field>;

  return (
    <Field label={label}>
      <Input
        type={type}
        step={step}
        min={min}
        placeholder={placeholder}
        aria-label={label}
        disabled={busy}
        className="h-8 w-48 text-xs"
        value={draft ?? value}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
          setDraft(event.currentTarget.value)
        }
        onBlur={() => {
          if (draft === null || draft === value) {
            setDraft(null);
            return;
          }
          onCommit(draft);
          setDraft(null);
        }}
        onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
}

function DueDateField({ task }: { task: TaskDetail }) {
  const update = useUpdateTask(task.id);
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <InlineEdit
        label="Due"
        type="date"
        busy={update.isPending}
        value={task.dueDate ?? ''}
        display={<DueBadge dueDate={task.dueDate} status={task.status} emptyLabel="No due date" />}
        onCommit={(next) => {
          setError(null);
          update.mutate(
            { dueDate: next === '' ? null : next },
            {
              onError: (cause: unknown) =>
                setError(cause instanceof Error ? cause.message : 'That date was refused.'),
            },
          );
        }}
      />
      {error ? (
        <p role="alert" className="mt-1 text-right text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function EstimateField({ task }: { task: TaskDetail }) {
  const update = useUpdateTask(task.id);
  const [error, setError] = useState<string | null>(null);

  const hours = task.estimatedMinutes === null ? '' : String(task.estimatedMinutes / 60);

  return (
    <div>
      <InlineEdit
        label="Estimate"
        type="number"
        step="0.5"
        min="0"
        placeholder="Hours"
        busy={update.isPending}
        value={hours}
        display={
          task.estimatedMinutes === null ? (
            <span className="text-xs text-ink-faint">No estimate</span>
          ) : (
            formatHours(task.estimatedMinutes)
          )
        }
        onCommit={(next) => {
          setError(null);
          update.mutate(
            { estimatedHours: next === '' ? null : Number(next) },
            {
              onError: (cause: unknown) =>
                setError(cause instanceof Error ? cause.message : 'That estimate was refused.'),
            },
          );
        }}
      />
      {error ? (
        <p role="alert" className="mt-1 text-right text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Labels, added and removed in place.
 *
 * The chips update the moment they are clicked and go back if the server says
 * no, because nobody wants to wait on a round trip to see a tag appear.
 */
function LabelsField({ task }: { task: TaskDetail }) {
  const { isLead } = useAuth();
  const labels = useLabels(task.projectId);
  const setLabels = useSetLabels(task.id, labels.data?.items ?? []);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = task.labels.map((label) => label.id);
  const available = (labels.data?.items ?? []).filter((label) => !chosen.includes(label.id));

  const change = (next: string[]) => {
    setError(null);
    setLabels.mutate(next, {
      onError: (cause) => setError(cause instanceof Error ? cause.message : 'That did not work.'),
    });
  };

  return (
    <div>
      <p className="mb-1.5 text-xs text-ink-muted">Labels</p>

      <div className="flex flex-wrap items-center gap-1.5">
        {task.labels.map((label) => (
          <span key={label.id} className="inline-flex items-center gap-1">
            <LabelChip name={label.name} color={label.color} />
            {isLead ? (
              <button
                type="button"
                aria-label={'Remove ' + label.name}
                className="text-ink-faint hover:text-danger"
                onClick={() => change(chosen.filter((id) => id !== label.id))}
              >
                <X size={11} />
              </button>
            ) : null}
          </span>
        ))}

        {task.labels.length === 0 && !isLead ? (
          <span className="text-xs text-ink-faint">None</span>
        ) : null}

        {isLead ? (
          adding ? (
            <Select
              aria-label="Add a label"
              className="h-7 w-32 text-xs"
              value=""
              onChange={(event) => {
                const chosenId = event.target.value;
                setAdding(false);
                if (chosenId) change([...chosen, chosenId]);
              }}
            >
              <option value="">Choose…</option>
              {available.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </Select>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5"
              onClick={() => setAdding(true)}
            >
              <Plus size={12} aria-hidden /> Label
            </Button>
          )
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function FieldsCard({ task }: { task: TaskDetail }) {
  const progress = useUpdateProgress(task.id);
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? task.progress;

  return (
    <Card className="space-y-4 p-4">
      <div>
        <Label htmlFor="progress">Progress</Label>
        <div className="mb-2 flex justify-center">
          {/* Unlabelled: the slider below is the labelled control, and the
              ring is the same number drawn. */}
          <RingGauge value={shown} size={104} />
        </div>
        <input
          id="progress"
          type="range"
          min={0}
          max={100}
          step={5}
          value={shown}
          // --fill drives the filled part of the track; see .range-token.
          style={{ ['--fill' as string]: shown + '%' }}
          className="range-token"
          onChange={(e) => setDraft(Number(e.currentTarget.value))}
          onPointerUp={() => {
            if (draft !== null && draft !== task.progress) progress.mutate(draft);
            setDraft(null);
          }}
          onKeyUp={() => {
            if (draft !== null && draft !== task.progress) progress.mutate(draft);
            setDraft(null);
          }}
        />
      </div>

      <AssigneeField task={task} />
      <ReviewerField task={task} />
      <Field label="Created by">
        <UserAvatar user={task.createdBy} showName size="sm" />
      </Field>
      {task.startDate ? <Field label="Start">{formatDate(task.startDate)}</Field> : null}
      <DueDateField task={task} />
      <EstimateField task={task} />
      <Field label="Last update">{relativeTime(task.lastActivityAt)}</Field>
      {task.completedAt ? (
        <Field label="Completed">{formatDateTime(task.completedAt)}</Field>
      ) : null}

      {task.dependsOn.length > 0 ? (
        <Field label="Waiting on">
          <span className="flex flex-col gap-1">
            {task.dependsOn.map((dependency) => (
              <Link
                key={dependency.taskId}
                to={'/tasks/' + dependency.key}
                className="truncate text-xs text-accent hover:underline"
              >
                {dependency.key} {dependency.title}
              </Link>
            ))}
          </span>
        </Field>
      ) : null}

      <LabelsField task={task} />

      {task.subtaskCount.total > 0 ? (
        <Field label="Subtasks">
          {task.subtaskCount.done} of {task.subtaskCount.total} done
        </Field>
      ) : null}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-xs text-ink-muted">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

/**
 * A colour per kind of event, from the shared status map wherever one applies.
 *
 * The dot is decoration: every row also says in words what happened, so the
 * colour is a shortcut for people who can use it and costs nothing to those
 * who cannot.
 */
function activityColour(action: string): string {
  if (action.startsWith('comment')) return 'var(--color-chart-4)';
  if (action.startsWith('attachment')) return 'var(--color-chart-3)';
  if (action === 'task.created') return statusColor('BACKLOG');
  if (action === 'task.assigned' || action === 'task.reviewer_changed') {
    return statusColor('ASSIGNED');
  }
  if (action === 'task.transitioned') return statusColor('IN_PROGRESS');
  if (action === 'task.progress') return 'var(--color-accent)';
  if (action === 'task.deleted') return statusColor('CANCELLED');
  return 'var(--color-border-strong)';
}

/** Activity rows are rendered as sentences, so the history reads like a story. */
function describe(entry: Extract<TimelineEntry, { kind: 'activity' }>): string {
  const who = entry.actor?.name ?? 'The system';
  const from = entry.oldValue;
  const to = entry.newValue;

  switch (entry.action) {
    case 'task.created':
      return who + ' created this task';
    case 'task.transitioned':
      return (
        who +
        ' moved it from ' +
        STATUS_LABELS[from as TaskStatus] +
        ' to ' +
        STATUS_LABELS[to as TaskStatus]
      );
    case 'task.progress':
      return who + ' changed progress from ' + String(from) + '% to ' + String(to) + '%';
    case 'task.assigned':
      return to ? who + ' changed the assignee' : who + ' removed the assignee';
    case 'task.reviewer_changed':
      return who + ' changed the reviewer';
    case 'task.updated':
      return who + ' changed ' + (entry.field ?? 'a field');
    case 'task.watcher_added':
      return who + ' started watching';
    case 'task.watcher_removed':
      return who + ' stopped watching';
    case 'task.dependency_added':
      return who + ' added a dependency';
    case 'task.dependency_removed':
      return who + ' removed a dependency';
    case 'task.deleted':
      return who + ' deleted this task';
    case 'comment.created':
      return '';
    case 'comment.edited':
      return who + ' edited a comment';
    case 'comment.deleted':
      return who + ' deleted a comment';
    default:
      return who + ' ' + entry.action;
  }
}

function TimelineCard({
  taskKey,
  entries,
  loading,
}: {
  taskKey: string | undefined;
  entries: TimelineEntry[] | undefined;
  loading: boolean;
}) {
  const { user } = useAuth();
  const addComment = useAddComment(taskKey, user ? { ...user, isActive: true } : null);
  const [body, setBody] = useState('');

  // The comment.created activity row would duplicate the comment itself.
  const visible = (entries ?? []).filter(
    (entry) => !(entry.kind === 'activity' && entry.action === 'comment.created'),
  );

  return (
    <Card className="p-4">
      <h2 className="mb-3 text-xs font-semibold text-ink-muted">Timeline</h2>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : (
        // A line down the left, with a dot per entry coloured by what happened.
        <ol className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[3.5px] before:w-px before:bg-border-subtle">
          {visible.map((entry) =>
            entry.kind === 'comment' ? (
              <li key={'c' + entry.id} className="flex gap-2.5">
                <UserAvatar user={entry.author} size="sm" />
                <div
                  className={
                    'min-w-0 flex-1 rounded-2xl rounded-tl-sm bg-surface-muted px-3.5 py-2.5' +
                    // Still on its way: shown, but visibly not yet landed.
                    (isPendingComment(entry.id) ? ' opacity-60' : '')
                  }
                >
                  <p className="text-xs text-ink-muted">
                    <span className="font-medium text-ink">{entry.author.name}</span>{' '}
                    {isPendingComment(entry.id) ? 'sending…' : relativeTime(entry.createdAt)}
                    {entry.editedAt ? ' · edited' : ''}
                  </p>
                  <div className="mt-1">
                    <CommentBody body={entry.body} meId={user?.id} />
                  </div>
                </div>
              </li>
            ) : (
              <li key={'a' + entry.id} className="flex items-baseline gap-2 text-xs text-ink-muted">
                <span
                  aria-hidden
                  /*
                   * relative, so the dot paints over the line behind it. The
                   * line is an absolutely positioned pseudo-element on the
                   * list, which puts it above its static children: it was
                   * drawn straight through every dot, and in the light theme,
                   * where the line is dark enough to see, that read as a row
                   * of half-circles.
                   */
                  className="relative z-10 mt-1 h-2 w-2 shrink-0 rounded-full ring-2 ring-surface"
                  style={{ background: activityColour(entry.action) }}
                />
                <span className="flex-1">{describe(entry)}</span>
                <time dateTime={entry.createdAt} className="shrink-0 text-ink-faint">
                  {relativeTime(entry.createdAt)}
                </time>
              </li>
            ),
          )}
        </ol>
      )}

      <form
        className="mt-4 border-t border-border-subtle pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!body.trim()) return;
          addComment.mutate(body.trim(), { onSuccess: () => setBody('') });
        }}
      >
        <MentionBox
          taskIdOrKey={taskKey ?? ''}
          aria-label="Add a comment"
          value={body}
          onChange={setBody}
          placeholder="Add a comment… type @ to mention somebody"
          onSubmit={() => {
            if (body.trim()) addComment.mutate(body.trim(), { onSuccess: () => setBody('') });
          }}
        />
        <div className="mt-2 flex justify-end">
          <Button type="submit" size="sm" disabled={!body.trim() || addComment.isPending}>
            {addComment.isPending ? <Spinner /> : null}
            Comment
          </Button>
        </div>
      </form>
    </Card>
  );
}
