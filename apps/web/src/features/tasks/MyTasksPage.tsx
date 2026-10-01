import { Link } from 'react-router-dom';
import type { TaskStatus, TaskSummary } from '@tm/shared';
import { canTransition } from '@tm/shared';
import { useTaskList, useTransitionTask } from './api';
import { useAuth } from '@/features/auth/AuthContext';
import {
  Button,
  Card,
  EmptyState,
  Figure,
  FigureLabel,
  HeroCard,
  Skeleton,
} from '@/components/ui/primitives';
import { DueBadge, PriorityIcon, ProgressBar, StatusBadge } from '@/components/common/badges';
import { cn, todayIso } from '@/lib/utils';

/**
 * A member's working screen. Tasks are grouped by when they are due, because that
 * is the order people actually work in, not by status or priority.
 */

interface Group {
  key: string;
  title: string;
  tone?: 'danger' | 'warning';
  match(task: TaskSummary, today: string, weekEnd: string): boolean;
}

/** Due-date order first, because that is the order people work in. */
const GROUPS: Group[] = [
  {
    key: 'overdue',
    title: 'Overdue',
    tone: 'danger',
    match: (task, today) => Boolean(task.dueDate && task.dueDate < today),
  },
  {
    key: 'today',
    title: 'Due today',
    tone: 'warning',
    match: (task, today) => task.dueDate === today,
  },
  {
    key: 'week',
    title: 'This week',
    match: (task, today, weekEnd) =>
      Boolean(task.dueDate && task.dueDate > today && task.dueDate <= weekEnd),
  },
  {
    key: 'later',
    title: 'Later',
    match: (task, _today, weekEnd) => !task.dueDate || task.dueDate > weekEnd,
  },
  {
    key: 'review',
    title: 'Waiting for your review',
    // Filled from the reviewer query, not from this person's own tasks.
    match: () => false,
  },
];

function endOfWeek(today: string): string {
  const date = new Date(today + 'T00:00:00');
  date.setDate(date.getDate() + (7 - ((date.getDay() + 6) % 7)));
  return date.toISOString().slice(0, 10);
}

export function MyTasksPage() {
  const today = todayIso();
  const weekEnd = endOfWeek(today);

  const mine = useTaskList({
    assigneeId: 'me',
    open: true,
    sort: 'dueDate',
    order: 'asc',
    limit: 100,
  });
  const toReview = useTaskList({
    reviewerId: 'me',
    status: ['READY_FOR_REVIEW', 'IN_REVIEW'],
    limit: 50,
  });

  const tasks = mine.data?.pages.flatMap((page) => page.items) ?? [];
  const reviews = toReview.data?.pages.flatMap((page) => page.items) ?? [];

  if (mine.isLoading) {
    return (
      <div className="mx-auto max-w-[1100px] space-y-3 px-4 py-6">
        <Skeleton className="h-8 w-40" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  const assigned = new Set<string>();
  const grouped = GROUPS.map((group) => {
    if (group.key === 'review') return { group, tasks: reviews };
    const matched = tasks.filter((task) => {
      if (assigned.has(task.id)) return false;
      if (!group.match(task, today, weekEnd)) return false;
      assigned.add(task.id);
      return true;
    });
    return { group, tasks: matched };
  }).filter((entry) => entry.tasks.length > 0);

  return (
    <div className="mx-auto max-w-[1100px] space-y-6 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">My tasks</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {tasks.length} open, {reviews.length} waiting on your review
        </p>
      </header>

      <MyDay tasks={tasks} reviews={reviews} today={today} />

      {grouped.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing on your plate"
            description="No open tasks are assigned to you."
          />
        </Card>
      ) : (
        grouped.map(({ group, tasks: groupTasks }) => (
          <section key={group.key} aria-labelledby={'group-' + group.key}>
            <h2
              id={'group-' + group.key}
              className={
                'mb-2 text-sm font-semibold ' +
                (group.tone === 'danger'
                  ? 'text-danger'
                  : group.tone === 'warning'
                    ? 'text-warning'
                    : '')
              }
            >
              {group.title}
              <span className="ml-2 font-normal text-ink-faint">{groupTasks.length}</span>
            </h2>
            <Card>
              <ul className="divide-y divide-border-subtle">
                {groupTasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </ul>
            </Card>
          </section>
        ))
      )}
    </div>
  );
}

/**
 * The three numbers worth knowing before opening anything.
 *
 * Deliberately the same dark card as the dashboard's, because it answers the
 * same kind of question: what is pressing, right now.
 */
function MyDay({
  tasks,
  reviews,
  today,
}: {
  tasks: TaskSummary[];
  reviews: TaskSummary[];
  today: string;
}) {
  const overdue = tasks.filter((task) => task.dueDate && task.dueDate < today).length;
  const dueToday = tasks.filter((task) => task.dueDate === today).length;

  const figures: Array<{ label: string; value: number; to: string; tone?: 'danger' | 'warning' }> =
    [
      {
        label: 'Due today',
        value: dueToday,
        to: '/tasks?assigneeId=me&dueToday=true',
        tone: 'warning',
      },
      { label: 'Overdue', value: overdue, to: '/tasks?assigneeId=me&overdue=true', tone: 'danger' },
      // The same words as the section below it, which is the list it opens.
      { label: 'Waiting on you', value: reviews.length, to: '/tasks?reviewerId=me' },
    ];

  return (
    <HeroCard>
      <div className="grid grid-cols-3 gap-3">
        {figures.map((figure) => (
          <Link
            key={figure.label}
            to={figure.to}
            className="min-w-0 rounded-xl p-1 hover:underline"
          >
            <FigureLabel>{figure.label}</FigureLabel>
            <div className="mt-1">
              <Figure
                value={figure.value}
                size="md"
                className={cn(
                  figure.tone === 'danger' && figure.value > 0 && 'text-danger',
                  figure.tone === 'warning' && figure.value > 0 && 'text-warning',
                )}
              />
            </div>
          </Link>
        ))}
      </div>
    </HeroCard>
  );
}

/**
 * Quick actions come from the workflow, so a member sees only what they may
 * do, and Blocked gets one too: it is the row most likely to need moving.
 */
function quickActionFor(task: TaskSummary): { label: string; to: TaskStatus } | null {
  const options: Array<{ label: string; to: TaskStatus }> = [
    { label: 'Start', to: 'IN_PROGRESS' },
    { label: 'Submit for review', to: 'READY_FOR_REVIEW' },
  ];

  if (task.status === 'ASSIGNED') return options[0] as { label: string; to: TaskStatus };
  if (task.status === 'IN_PROGRESS') return options[1] as { label: string; to: TaskStatus };
  if (task.status === 'CHANGES_REQUESTED' || task.status === 'BLOCKED') {
    return { label: 'Resume', to: 'IN_PROGRESS' };
  }
  return null;
}

/**
 * One row, two shapes.
 *
 * From md it is six fixed tracks, and the action track is there whether or
 * not the row has an action: with `auto` the columns re-measured per row, so
 * a row without a button put its due date where the row above put its
 * status, and nothing lined up down the page. The title takes the 1fr track
 * so it gets the space left over rather than a share of it.
 *
 * On a phone the title has its own full-width line and may run to two before
 * it truncates, because one line of a truncated title is often just the
 * project noun.
 */
function TaskRow({ task }: { task: TaskSummary }) {
  const transition = useTransitionTask(task.id);
  const { user } = useAuth();

  const candidate = quickActionFor(task);

  /*
   * Offered only if the workflow would accept it from this person: a button
   * that always fails is worse than no button. The relationships are the
   * ones the browser can actually know. isTeamLeadOfProject is left false
   * because a TaskSummary carries no team, and on this screen it does not
   * matter: every row here is the reader's own work, so being the assignee
   * is the relationship the rules are looking at.
   */
  const quickAction =
    candidate &&
    user &&
    canTransition(task.status, candidate.to, {
      role: user.role,
      isAssignee: task.assignee?.id === user.id,
      isReviewer: task.reviewer?.id === user.id,
      isTeamLeadOfProject: false,
    }).ok
      ? candidate
      : null;

  return (
    <li
      className={cn(
        'grid grid-cols-1 gap-x-3 gap-y-2 px-4 py-3',
        /*
         * minmax(240px, 1fr) for the title: with minmax(0, 1fr) the other
         * five tracks took what they wanted first and left the title about
         * 185px, which cut words mid-letter. 240 is the floor, and the page
         * is wider now so there is something to give it.
         */
        'md:grid-cols-[78px_minmax(240px,1fr)_96px_124px_80px_120px] md:items-center md:gap-y-0',
      )}
    >
      <Link
        to={'/tasks/' + task.key}
        title={task.title}
        className="order-1 min-w-0 text-sm hover:underline md:order-2 md:truncate"
      >
        {/* Two lines before it gives up, on a phone only. */}
        <span className="line-clamp-2 md:line-clamp-none">{task.title}</span>
      </Link>

      <div className="order-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 md:order-1 md:contents">
        <span className="flex shrink-0 items-center gap-1.5">
          <PriorityIcon priority={task.priority} />
          <Link to={'/tasks/' + task.key} className="font-mono text-xs text-accent hover:underline">
            {task.key}
          </Link>
        </span>

        <span className="min-w-16 flex-1 md:order-3 md:flex-none">
          {/*
            No number beside the bar. It cost a track's worth of width to
            repeat what the bar already shows, and it is still announced:
            ProgressBar puts the percentage in aria-valuetext.
          */}
          <ProgressBar value={task.progress} label={task.key + ' progress'} />
        </span>

        <span className="shrink-0 md:order-4">
          <StatusBadge status={task.status} />
        </span>

        <span className="shrink-0 md:order-5">
          <DueBadge
            dueDate={task.dueDate}
            status={task.status}
            workingDaysLate={task.workingDaysLate}
            emptyLabel={null}
          />
        </span>

        {/*
          The track exists even when the row has no action, so every row's
          columns start in the same place.
        */}
        <span className="ml-auto shrink-0 md:order-6 md:ml-0 md:justify-self-end">
          {quickAction ? (
            <Button
              size="sm"
              variant="outline"
              disabled={transition.isPending}
              onClick={() => transition.mutate({ to: quickAction.to })}
            >
              {quickAction.label}
            </Button>
          ) : null}
        </span>
      </div>
    </li>
  );
}
