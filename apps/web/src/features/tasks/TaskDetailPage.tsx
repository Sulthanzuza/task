import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import type { TaskDetail, TaskStatus, TimelineEntry, TransitionRequirement } from '@tm/shared';
import { STATUS_LABELS, stripMentionMarkup } from '@tm/shared';
import {
  useAddComment,
  useTask,
  useTaskTimeline,
  useTransitionTask,
  useUpdateProgress,
  useWatchToggle,
} from './api';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';
import {
  Button,
  Card,
  EmptyState,
  Label,
  Skeleton,
  Spinner,
  Textarea,
} from '@/components/ui/primitives';
import {
  BlockerBadge,
  DueBadge,
  LabelChip,
  PriorityBadge,
  ProgressBar,
  StatusBadge,
  UserAvatar,
} from '@/components/common/badges';
import { formatDate, formatDateTime, formatHours, relativeTime } from '@/lib/utils';
import { TransitionDialog } from './TransitionDialog';

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
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <TaskHeader task={task.data} />
          <TransitionBar task={task.data} />
          <DescriptionCard task={task.data} />
          <TimelineCard taskKey={key} entries={timeline.data?.items} loading={timeline.isLoading} />
        </div>

        <aside className="space-y-4">
          <FieldsCard task={task.data} />
        </aside>
      </div>
    </div>
  );
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
        <DueBadge dueDate={task.dueDate} status={task.status} />
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
 * The buttons come from availableTransitions, which the server computed from the
 * same workflow table it will validate against. The UI never guesses what is allowed.
 */
function TransitionBar({ task }: { task: TaskDetail }) {
  const transition = useTransitionTask(task.id);
  const [pending, setPending] = useState<{ to: TaskStatus; requires: TransitionRequirement[] } | null>(
    null,
  );
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
    transition.mutate(
      { to, ...extra } as Parameters<typeof transition.mutate>[0],
      {
        onSuccess: () => setPending(null),
        onError: (err) => setError(err instanceof ApiError ? err.message : 'That change failed.'),
      },
    );
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {task.availableTransitions.map((option) => (
          <Button
            key={option.to}
            size="sm"
            variant={option.to === 'COMPLETED' ? 'primary' : 'outline'}
            disabled={transition.isPending}
            onClick={() =>
              option.requires.length > 0
                ? setPending({ to: option.to, requires: option.requires })
                : run(option.to)
            }
          >
            {option.label}
          </Button>
        ))}
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
        <p className="text-sm whitespace-pre-wrap text-ink">{task.description}</p>
      ) : (
        <p className="text-sm text-ink-faint">No description yet.</p>
      )}
    </Card>
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
        <input
          id="progress"
          type="range"
          min={0}
          max={100}
          step={5}
          value={shown}
          className="w-full accent-[var(--color-accent)]"
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
        <ProgressBar value={shown} showLabel />
      </div>

      <Field label="Assignee">
        <UserAvatar user={task.assignee} showName size="sm" />
      </Field>
      <Field label="Reviewer">
        <UserAvatar user={task.reviewer} showName size="sm" />
      </Field>
      <Field label="Created by">
        <UserAvatar user={task.createdBy} showName size="sm" />
      </Field>
      <Field label="Start">{formatDate(task.startDate)}</Field>
      <Field label="Due">
        <DueBadge dueDate={task.dueDate} status={task.status} />
      </Field>
      <Field label="Estimate">{formatHours(task.estimatedMinutes)}</Field>
      <Field label="Last update">{relativeTime(task.lastActivityAt)}</Field>
      {task.completedAt ? <Field label="Completed">{formatDateTime(task.completedAt)}</Field> : null}

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
  const addComment = useAddComment(taskKey);
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
        <ol className="space-y-3">
          {visible.map((entry) =>
            entry.kind === 'comment' ? (
              <li key={'c' + entry.id} className="flex gap-2.5">
                <UserAvatar user={entry.author} size="sm" />
                <div className="min-w-0 flex-1 rounded-lg bg-surface-muted px-3 py-2">
                  <p className="text-xs text-ink-muted">
                    <span className="font-medium text-ink">{entry.author.name}</span>{' '}
                    {relativeTime(entry.createdAt)}
                    {entry.editedAt ? ' · edited' : ''}
                  </p>
                  <p className="mt-1 text-sm whitespace-pre-wrap">{stripMentionMarkup(entry.body)}</p>
                </div>
              </li>
            ) : (
              <li key={'a' + entry.id} className="flex items-baseline gap-2 text-xs text-ink-muted">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-border-subtle" />
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
        <Textarea
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
          placeholder="Add a comment…"
          className="min-h-16"
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
