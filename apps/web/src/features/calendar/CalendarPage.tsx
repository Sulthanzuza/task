import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { TaskSummary } from '@tm/shared';
import { priorityColor, tintedPill, PRIORITY_LABELS } from '@tm/shared';
import { useTaskList } from '@/features/tasks/api';
import { useProjects, useUsers } from '@/features/team/api';
import { Button, Card, EmptyState, Select, Skeleton } from '@/components/ui/primitives';
import { PriorityIcon, StatusBadge } from '@/components/common/badges';
import { nonWorkingDay, useWorkCalendar } from './api';
import { cn } from '@/lib/utils';

/**
 * Tasks by due date.
 *
 * "Today" comes from the work calendar, which computes it in the org time
 * zone. Using the browser's clock would put a task on the wrong day for anyone
 * working in a different zone, which is exactly the bug the server-side date
 * rules exist to prevent.
 */

type ViewMode = 'month' | 'week';

/** Plain calendar arithmetic on YYYY-MM-DD strings; no time zone involved. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + days));
  return shifted.toISOString().slice(0, 10);
}

function startOfMonth(date: string): string {
  return date.slice(0, 8) + '01';
}

function startOfGrid(date: string, weekStartsOn = 1): string {
  const first = startOfMonth(date);
  const [y, m, d] = first.split('-').map(Number);
  const weekday = new Date(Date.UTC(y as number, (m as number) - 1, d as number)).getUTCDay();
  return addDays(first, -((weekday - weekStartsOn + 7) % 7));
}

function startOfWeek(date: string, weekStartsOn = 1): string {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y as number, (m as number) - 1, d as number)).getUTCDay();
  return addDays(date, -((weekday - weekStartsOn + 7) % 7));
}

function monthLabel(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
    new Date(Date.UTC(y as number, (m as number) - 1, 1)),
  );
}

export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  // null until somebody taps a day; today is the default, resolved below
  // once the organisation's today is known.
  const [picked, setPicked] = useState<string | null>(null);
  const workCalendar = useWorkCalendar();
  const projects = useProjects();
  const people = useUsers();

  // The org's today, not the browser's.
  const today = workCalendar.data?.today;

  const view = (params.get('view') as ViewMode) ?? 'month';
  const anchor = params.get('date') ?? today;
  const projectId = params.get('projectId') ?? undefined;
  const assigneeId = params.get('assigneeId') ?? undefined;

  const range = useMemo(() => {
    if (!anchor) return null;
    if (view === 'week') {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 6), days: 7 };
    }
    const from = startOfGrid(anchor);
    return { from, to: addDays(from, 41), days: 42 };
  }, [anchor, view]);

  const query = useTaskList(
    range
      ? { dueFrom: range.from, dueTo: range.to, projectId, assigneeId, limit: 100 }
      : { limit: 1 },
  );

  const pages = query.data?.pages;

  const byDate = useMemo(() => {
    const grouped = new Map<string, TaskSummary[]>();
    for (const task of pages?.flatMap((page) => page.items) ?? []) {
      if (!task.dueDate) continue;
      const list = grouped.get(task.dueDate) ?? [];
      list.push(task);
      grouped.set(task.dueDate, list);
    }
    return grouped;
  }, [pages]);

  function setParam(key: string, value: string | undefined) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  function shift(direction: -1 | 1) {
    if (!anchor) return;
    setParam(
      'date',
      view === 'week'
        ? addDays(anchor, direction * 7)
        : addDays(startOfMonth(anchor), direction * 32).slice(0, 8) + '01',
    );
  }

  if (workCalendar.isError) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <Card>
          <EmptyState
            title="The calendar could not be loaded"
            action={<Button onClick={() => void workCalendar.refetch()}>Try again</Button>}
          />
        </Card>
      </div>
    );
  }

  if (!range || !today) {
    return (
      <div className="mx-auto max-w-6xl space-y-3 px-4 py-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const days = Array.from({ length: range.days }, (_, i) => addDays(range.from, i));
  const currentMonth = (anchor ?? today).slice(0, 7);

  // Today, until somebody taps another day.
  const selected = picked ?? today;
  const selectedTasks = byDate.get(selected) ?? [];
  const selectedHoliday = nonWorkingDay(selected, workCalendar.data).holiday;
  const selectedLabel = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(selected + 'T00:00:00'));

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Calendar</h1>

        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Previous" onClick={() => shift(-1)}>
            <ChevronLeft size={16} />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium">
            {monthLabel(anchor ?? today)}
          </span>
          <Button variant="ghost" size="icon" aria-label="Next" onClick={() => shift(1)}>
            <ChevronRight size={16} />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setParam('date', undefined)}>
            Today
          </Button>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            className="w-auto min-w-28"
            aria-label="View"
            value={view}
            onChange={(e) => setParam('view', e.currentTarget.value)}
          >
            <option value="month">Month</option>
            <option value="week">Week</option>
          </Select>

          <Select
            className="w-auto min-w-28"
            aria-label="Project"
            value={projectId ?? ''}
            onChange={(e) => setParam('projectId', e.currentTarget.value || undefined)}
          >
            <option value="">All projects</option>
            {projects.data?.items.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key}
              </option>
            ))}
          </Select>

          <Select
            className="w-auto min-w-28"
            aria-label="Member"
            value={assigneeId ?? ''}
            onChange={(e) => setParam('assigneeId', e.currentTarget.value || undefined)}
          >
            <option value="">Anyone</option>
            {people.data?.items.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </div>
      </header>

      <p className="text-xs text-ink-muted">
        Dates are shown in {workCalendar.data?.timezone}, the organisation time zone.
      </p>

      <Card className="overflow-hidden">
        <div className="grid grid-cols-7 border-b border-border-subtle">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
            <div key={label} className="px-2 py-1.5 text-center text-xs font-medium text-ink-muted">
              {label}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7">
          {days.map((date) => {
            const dayTasks = byDate.get(date) ?? [];
            const isToday = date === today;
            const outside = view === 'month' && date.slice(0, 7) !== currentMonth;
            const { weekend, holiday } = nonWorkingDay(date, workCalendar.data);
            const resting = weekend || holiday !== null;
            const picked = date === selected;

            return (
              <button
                type="button"
                key={date}
                data-date={date}
                data-today={isToday ? 'true' : undefined}
                aria-pressed={picked}
                onClick={() => setPicked(date)}
                className={cn(
                  'min-h-24 border-r border-b border-border-subtle p-1.5 text-left last:border-r-0',
                  // No opacity: it fades the text inside below contrast. The
                  // muted day number is what sets a neighbouring month back.
                  view === 'week' && 'min-h-64',
                  // Below 640 a cell is barely wider than a thumb.
                  'max-sm:min-h-14',
                  picked && 'ring-2 ring-accent ring-inset sm:ring-0',
                )}
                /*
                 * Hatched, exactly as the heat map does it: a day nobody
                 * works is obviously different from a working day with
                 * nothing due on it, and a flat tint reads as the latter.
                 */
                style={
                  resting
                    ? {
                        backgroundImage:
                          'repeating-linear-gradient(45deg, var(--color-border-subtle) 0 1px, transparent 1px 6px)',
                      }
                    : undefined
                }
                title={holiday ?? undefined}
              >
                <div className="mb-1 flex items-center gap-1">
                  <span
                    className={cn(
                      'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs tabular-nums',
                      // Days from the neighbouring months are set back by one
                      // step, ink to muted, not to faint: faint is decoration
                      // and fails contrast on a number someone has to read.
                      isToday
                        ? 'accent-gradient font-semibold text-[var(--color-accent-ink)]'
                        : outside
                          ? 'text-ink-muted'
                          : 'text-ink',
                    )}
                  >
                    {Number(date.slice(8, 10))}
                  </span>
                  {dayTasks.length > 0 ? (
                    <span className="tabular text-[10px] text-ink-faint">{dayTasks.length}</span>
                  ) : null}
                </div>

                {/* The holiday's name, where there is room for it. */}
                {holiday ? (
                  <p className="mb-1 hidden truncate text-[10px] text-ink-faint sm:block">
                    {holiday}
                  </p>
                ) : null}

                {/*
                  A dot per task below 640. A chip shrunk to a single letter
                  tells you nothing; a row of coloured dots and a count tells
                  you how heavy the day is, which is what a month view is for.
                */}
                <div className="flex flex-wrap gap-1 sm:hidden">
                  {dayTasks.slice(0, 6).map((task) => (
                    <span
                      key={task.id}
                      aria-hidden
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: priorityColor(task.priority) }}
                    />
                  ))}
                </div>

                <div className="hidden space-y-1 sm:block">
                  {dayTasks.slice(0, view === 'week' ? 20 : 3).map((task) => (
                    <Link
                      key={task.id}
                      to={'/tasks/' + task.key}
                      data-task-key={task.key}
                      onClick={(event) => event.stopPropagation()}
                      title={
                        task.key + ' ' + task.title + ' (' + PRIORITY_LABELS[task.priority] + ')'
                      }
                      // Coloured by priority from the shared map, so a chip
                      // here means the same as a badge anywhere else.
                      style={tintedPill(priorityColor(task.priority))}
                      className="block truncate rounded-full border px-2 py-0.5 text-[11px] hover:underline"
                    >
                      {task.key} {task.title}
                    </Link>
                  ))}
                  {view === 'month' && dayTasks.length > 3 ? (
                    <Link
                      to={'/tasks?dueFrom=' + date + '&dueTo=' + date}
                      onClick={(event) => event.stopPropagation()}
                      className="block px-1.5 text-[10px] text-ink-muted hover:underline"
                    >
                      {dayTasks.length - 3} more
                    </Link>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      {/*
        The chosen day, in full, under the grid. On a phone the cells can
        only carry dots, so this is where the day is actually read; above
        640 the cells already list their tasks and this would repeat them.
      */}
      <Card className="sm:hidden">
        <h2 className="mb-2 text-sm font-semibold">
          {selectedLabel}
          {selectedHoliday ? (
            <span className="ml-2 text-xs font-normal text-ink-faint">{selectedHoliday}</span>
          ) : null}
        </h2>

        {selectedTasks.length === 0 ? (
          <p className="text-xs text-ink-faint">Nothing due.</p>
        ) : (
          <ul className="space-y-2">
            {selectedTasks.map((task) => (
              <li key={task.id}>
                <Link
                  to={'/tasks/' + task.key}
                  className="flex items-center gap-2 rounded-lg border border-border-subtle px-2.5 py-2"
                >
                  <PriorityIcon priority={task.priority} size={12} />
                  <span className="font-mono text-[11px] text-accent">{task.key}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                  <StatusBadge status={task.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
