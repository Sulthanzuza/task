import { Link, useParams } from 'react-router-dom';
import { useMemberStats } from '@/features/dashboard/api';
import { useTaskList } from '@/features/tasks/api';
import { useAuth } from '@/features/auth/AuthContext';
import type { ApiError } from '@/lib/api';
import { Button, Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import {
  DueBadge,
  PriorityBadge,
  ProgressBar,
  StatusBadge,
  UserAvatar,
} from '@/components/common/badges';
import { relativeTime } from '@/lib/utils';

/**
 * A member opens their own page and sees exactly what their lead sees about them.
 * These are facts with links to the evidence, never a score or a ranking.
 */
export function MemberPage() {
  const { userId } = useParams<{ userId: string }>();
  const { user } = useAuth();
  const stats = useMemberStats(userId);
  const tasks = useTaskList({ assigneeId: userId, open: true, sort: 'dueDate', order: 'asc', limit: 50 });

  const isSelf = user?.id === userId;

  if (stats.isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <Skeleton className="h-10 w-52" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (stats.isError) {
    const error = stats.error as ApiError;
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <Card>
          <EmptyState
            title={error.status === 403 ? 'That page is not yours to see' : 'Could not load this page'}
            description={error.message}
            action={
              <Button variant="outline" asChild>
                <Link to="/my-tasks">Back to my tasks</Link>
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  if (!stats.data) return null;

  const openTasks = tasks.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <header className="flex items-center gap-3">
        <UserAvatar user={stats.data.user} />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {stats.data.user.name}
            {isSelf ? <span className="ml-2 text-sm font-normal text-ink-faint">(you)</span> : null}
          </h1>
          <p className="text-sm text-ink-muted">
            Last update{' '}
            {stats.data.lastActivityAt ? relativeTime(stats.data.lastActivityAt) : 'never'}
          </p>
        </div>
      </header>

      <section aria-label="Statistics" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Active" value={stats.data.active} />
        <StatCard label="Overdue" value={stats.data.overdue} tone="danger" />
        <StatCard label="Blocked" value={stats.data.blocked} tone="danger" />
        <StatCard label="In review" value={stats.data.waitingReview} />
        <StatCard label="Done, 30 days" value={stats.data.completedLast30Days} />
        <StatCard
          label="On-time rate"
          value={
            stats.data.onTimeRate === null ? '—' : Math.round(stats.data.onTimeRate * 100) + '%'
          }
          hint="Completed on or before the due date, last 30 days"
        />
      </section>

      {stats.data.medianCompletionHours !== null ? (
        <p className="text-xs text-ink-muted">
          Median time from starting to finishing a task, over the last 30 days:{' '}
          <strong className="font-medium text-ink">{stats.data.medianCompletionHours} hours</strong>.
          The median is used so one unusual task does not skew the figure.
        </p>
      ) : null}

      <section aria-labelledby="current-work">
        <h2 id="current-work" className="mb-2 text-sm font-semibold">
          Current work
        </h2>
        <Card>
          {tasks.isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : openTasks.length === 0 ? (
            <EmptyState title="No open tasks" />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {openTasks.map((task) => (
                <li key={task.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                  <Link
                    to={'/tasks/' + task.key}
                    className="font-mono text-xs text-accent hover:underline"
                  >
                    {task.key}
                  </Link>
                  <Link
                    to={'/tasks/' + task.key}
                    className="min-w-40 flex-1 truncate text-sm hover:underline"
                  >
                    {task.title}
                  </Link>
                  <ProgressBar value={task.progress} className="w-24" showLabel />
                  <PriorityBadge priority={task.priority} />
                  <StatusBadge status={task.status} />
                  <DueBadge dueDate={task.dueDate} status={task.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number | string;
  tone?: 'danger';
  hint?: string;
}) {
  const highlight = tone === 'danger' && typeof value === 'number' && value > 0;
  return (
    <Card className="p-3" >
      <p className="text-xs text-ink-muted" title={hint}>
        {label}
      </p>
      <p className={'mt-1 text-xl font-semibold tabular-nums ' + (highlight ? 'text-danger' : '')}>
        {value}
      </p>
    </Card>
  );
}
