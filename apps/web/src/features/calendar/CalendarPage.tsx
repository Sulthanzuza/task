import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { TaskPriority, TaskSummary } from '@tm/shared';
import { PRIORITY_LABELS } from '@tm/shared';
import { useTaskList } from '@/features/tasks/api';
import { useProjects, useUsers } from '@/features/team/api';
import { useDashboardSummary } from '@/features/dashboard/api';
import { useAuth } from '@/features/auth/AuthContext';
import { Button, Card, Select, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * Tasks by due date.
 *
 * "Today" comes from the dashboard summary, which computes it in the org time
 * zone. Using the browser's clock would put a task on the wrong day for anyone
 * working in a different zone, which is exactly the bug the server-side date
 * rules exist to prevent.
 */

type ViewMode = 'month' | 'week';

const PRIORITY_TONE: Record<TaskPriority, string> = {
  LOW: 'bg-neutral-soft text-ink-muted',
  MEDIUM: 'bg-info-soft text-info',
  HIGH: 'bg-warning-soft text-warning',
  URGENT: 'bg-danger-soft text-danger',
};

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
  const { primaryTeamId } = useAuth();
  const projects = useProjects();
  const people = useUsers();

  // The org's today, not the browser's.
  const summary = useDashboardSummary(primaryTeamId);
  const today = summary.data?.asOfDate;

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
    setParam('date', view === 'week' ? addDays(anchor, direction * 7) : addDays(startOfMonth(anchor), direction * 32).slice(0, 8) + '01');
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

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight">Calendar</h1>

        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Previous" onClick={() => shift(-1)}>
            <ChevronLeft size={16} />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium">{monthLabel(anchor ?? today)}</span>
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
        Dates are shown in {summary.data?.timezone}, the organisation time zone.
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

            return (
              <div
                key={date}
                data-date={date}
                className={cn(
                  'min-h-24 border-r border-b border-border-subtle p-1.5 last:border-r-0',
                  outside && 'bg-surface-muted/40',
                  view === 'week' && 'min-h-64',
                )}
              >
                <div className="mb-1 flex items-center gap-1">
                  <span
                    className={cn(
                      'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs tabular-nums',
                      isToday ? 'bg-accent font-semibold text-white' : 'text-ink-muted',
                      outside && 'text-ink-faint',
                    )}
                  >
                    {Number(date.slice(8, 10))}
                  </span>
                  {dayTasks.length > 0 ? (
                    <span className="text-[10px] text-ink-faint">{dayTasks.length}</span>
                  ) : null}
                </div>

                <div className="space-y-1">
                  {dayTasks.slice(0, view === 'week' ? 20 : 3).map((task) => (
                    <Link
                      key={task.id}
                      to={'/tasks/' + task.key}
                      data-task-key={task.key}
                      title={task.key + ' ' + task.title + ' (' + PRIORITY_LABELS[task.priority] + ')'}
                      className={cn(
                        'block truncate rounded px-1.5 py-0.5 text-[11px] hover:underline',
                        PRIORITY_TONE[task.priority],
                      )}
                    >
                      {task.key} {task.title}
                    </Link>
                  ))}
                  {view === 'month' && dayTasks.length > 3 ? (
                    <Link
                      to={'/tasks?dueFrom=' + date + '&dueTo=' + date}
                      className="block px-1.5 text-[10px] text-ink-muted hover:underline"
                    >
                      {dayTasks.length - 3} more
                    </Link>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
