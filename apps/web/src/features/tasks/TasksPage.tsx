import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Users } from 'lucide-react';
import type { ListTasksQuery, TaskPriority, TaskStatus } from '@tm/shared';
import { PRIORITY_LABELS, STATUS_LABELS, TASK_PRIORITIES, TASK_STATUSES } from '@tm/shared';
import { useTaskList } from './api';
import { CreateTaskDialog } from './CreateTaskDialog';
import { useProjects, useUsers } from '@/features/team/api';
import { useAuth } from '@/features/auth/AuthContext';
import { Button, Card, EmptyState, Input, Select, Skeleton } from '@/components/ui/primitives';
import {
  DueBadge,
  LabelChip,
  PriorityIcon,
  ProgressBar,
  StatusBadge,
  UserAvatar,
  RelativeTime,
} from '@/components/common/badges';
import { DataTable, type Column } from '@/components/common/table';

/**
 * Filters live in the URL, so a filtered view can be bookmarked, shared in chat,
 * and linked to from the dashboard KPI cards.
 */
function useFilters() {
  const [params, setParams] = useSearchParams();

  const filters = useMemo<Partial<ListTasksQuery>>(() => {
    const get = (key: string) => params.get(key) ?? undefined;
    const list = (key: string) => {
      const raw = params.get(key);
      return raw ? raw.split(',').filter(Boolean) : undefined;
    };

    return {
      projectId: get('projectId'),
      assigneeId: get('assigneeId') as ListTasksQuery['assigneeId'],
      status: list('status') as TaskStatus[] | undefined,
      priority: list('priority') as TaskPriority[] | undefined,
      q: get('q'),
      overdue: params.get('overdue') === 'true' ? true : undefined,
      blocked: params.get('blocked') === 'true' ? true : undefined,
      noUpdate: params.get('noUpdate') === 'true' ? true : undefined,
      open: params.get('open') === 'true' ? true : undefined,
      active: params.get('active') === 'true' ? true : undefined,
      dueToday: params.get('dueToday') === 'true' ? true : undefined,
      completedThisWeek: params.get('completedThisWeek') === 'true' ? true : undefined,
      sort: (get('sort') ?? 'lastActivityAt') as ListTasksQuery['sort'],
      order: (get('order') ?? 'desc') as 'asc' | 'desc',
    };
  }, [params]);

  const setFilter = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(params);
    if (value === undefined || value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const clearAll = () => setParams(new URLSearchParams(), { replace: true });

  const activeCount = [...params.keys()].filter((k) => k !== 'sort' && k !== 'order').length;

  return { params, filters, setFilter, clearAll, activeCount };
}

/**
 * Fixed widths, so the key column is the same width on every screen and a
 * long title truncates rather than pushing the dates out of sight.
 */
const TASK_COLUMNS: Column[] = [
  { label: 'Key', width: '9rem' },
  { label: 'Title', width: 'auto' },
  { label: 'Assignee', width: '11rem' },
  { label: 'Status', width: '10rem' },
  { label: 'Progress', width: '8.5rem' },
  { label: 'Due', width: '7rem' },
  { label: 'Last update', width: '8rem' },
];

export function TasksPage() {
  const { filters, params, setFilter, clearAll, activeCount } = useFilters();
  const { isLead } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);

  const projects = useProjects();
  const people = useUsers();
  const query = useTaskList(filters);

  const tasks = query.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Tasks</h1>
        <span className="text-sm text-ink-faint">
          {query.isLoading ? '' : tasks.length + (query.hasNextPage ? '+' : '') + ' shown'}
        </span>
        {isLead ? (
          <Button className="ml-auto" onClick={() => setCreateOpen(true)}>
            <Plus size={16} />
            New task
          </Button>
        ) : null}
      </header>

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="min-w-44 flex-1">
          <Input
            type="search"
            placeholder="Search title or description"
            defaultValue={params.get('q') ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value;
              // Wait for a pause in typing rather than querying on every keystroke.
              window.clearTimeout((window as unknown as { __tmSearch?: number }).__tmSearch);
              (window as unknown as { __tmSearch?: number }).__tmSearch = window.setTimeout(
                () => setFilter('q', value || undefined),
                300,
              );
            }}
          />
        </div>

        <Select
          className="w-auto min-w-32 rounded-full"
          value={params.get('projectId') ?? ''}
          onChange={(e) => setFilter('projectId', e.currentTarget.value || undefined)}
          aria-label="Project"
        >
          <option value="">All projects</option>
          {projects.data?.items.map((project) => (
            <option key={project.id} value={project.id}>
              {project.key}
            </option>
          ))}
        </Select>

        <Select
          className="w-auto min-w-32 rounded-full"
          value={params.get('assigneeId') ?? ''}
          onChange={(e) => setFilter('assigneeId', e.currentTarget.value || undefined)}
          aria-label="Assignee"
        >
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="none">Unassigned</option>
          {people.data?.items.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name}
            </option>
          ))}
        </Select>

        <Select
          className="w-auto min-w-32 rounded-full"
          value={params.get('status') ?? ''}
          onChange={(e) => setFilter('status', e.currentTarget.value || undefined)}
          aria-label="Status"
        >
          <option value="">Any status</option>
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </Select>

        <Select
          className="w-auto min-w-28"
          value={params.get('priority') ?? ''}
          onChange={(e) => setFilter('priority', e.currentTarget.value || undefined)}
          aria-label="Priority"
        >
          <option value="">Any priority</option>
          {TASK_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_LABELS[priority]}
            </option>
          ))}
        </Select>

        <Toggle
          label="Overdue"
          active={params.get('overdue') === 'true'}
          onClick={() => setFilter('overdue', params.get('overdue') ? undefined : 'true')}
        />
        <Toggle
          label="Blocked"
          active={params.get('blocked') === 'true'}
          onClick={() => setFilter('blocked', params.get('blocked') ? undefined : 'true')}
        />
        <Toggle
          label="No update"
          active={params.get('noUpdate') === 'true'}
          onClick={() => setFilter('noUpdate', params.get('noUpdate') ? undefined : 'true')}
        />

        {activeCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={clearAll}>
            Clear
          </Button>
        ) : null}
      </Card>

      {/*
        overflow-hidden only while the table scrolls sideways. Any ancestor
        with a clipped overflow is a scrollport, and a sticky header measures
        itself against the nearest one: with it on at every width the header
        parked 64px down inside this card instead of under the top bar.
      */}
      <Card className="overflow-hidden md:overflow-visible">
        {query.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : query.isError ? (
          <EmptyState
            title="Could not load the tasks"
            description={(query.error as Error).message}
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            }
          />
        ) : tasks.length === 0 ? (
          <EmptyState
            title="No tasks match"
            description={activeCount > 0 ? 'Try widening the filters.' : 'Create the first one.'}
            action={
              activeCount > 0 ? (
                <Button variant="outline" onClick={clearAll}>
                  Clear the filters
                </Button>
              ) : null
            }
          />
        ) : (
          <DataTable columns={TASK_COLUMNS} sticky>
            <tbody>
              {tasks.map((task) => (
                <tr
                  key={task.id}
                  className="border-b border-border-subtle last:border-0 hover:bg-surface-muted"
                >
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="flex items-center gap-1.5">
                      <PriorityIcon priority={task.priority} />
                      <Link
                        to={'/tasks/' + task.key}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {task.key}
                      </Link>
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <Link
                      to={'/tasks/' + task.key}
                      title={task.title}
                      className="flex min-w-0 items-center gap-1.5 hover:underline"
                    >
                      {/*
                        A group is one line here, not eight. The icon and the
                        head count say it stands for several people's work
                        without listing them.
                      */}
                      {task.isGroup ? (
                        <Users size={13} aria-label="Group task" className="shrink-0 text-accent" />
                      ) : null}
                      <span className="truncate">{task.title}</span>
                    </Link>
                    {task.labels.length > 0 ? (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {task.labels.map((label) => (
                          <LabelChip key={label.id} name={label.name} color={label.color} />
                        ))}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">
                    <UserAvatar user={task.assignee} size="sm" />
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={task.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    <ProgressBar value={task.progress} showLabel />
                  </td>
                  <td className="px-3 py-2.5">
                    <DueBadge
                      dueDate={task.dueDate}
                      status={task.status}
                      workingDaysLate={task.workingDaysLate}
                    />
                  </td>
                  <td className="px-3 py-2.5 text-xs whitespace-nowrap text-ink-muted">
                    <RelativeTime iso={task.lastActivityAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}

      <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function Toggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'primary' : 'outline'}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
