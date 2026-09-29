import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Ban, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import type { TaskDetail, TaskStatus, TaskSummary, TransitionRequirement } from '@tm/shared';
import {
  BOARD_COLUMNS,
  COLLAPSED_BOARD_COLUMNS,
  STATUS_LABELS,
  canTransition,
} from '@tm/shared';
import { useBoardSummary, useTaskList, useTransitionTask } from '@/features/tasks/api';
import { useProjects } from '@/features/team/api';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError, api } from '@/lib/api';
import { Button, Card, EmptyState, Select, Skeleton } from '@/components/ui/primitives';
import {
  DueBadge,
  PriorityBadge,
  ProgressBar,
  UserAvatar,
} from '@/components/common/badges';
import { TransitionDialog } from '@/features/tasks/TransitionDialog';
import { cn } from '@/lib/utils';

/**
 * The Kanban board.
 *
 * Whether a card may be dropped on a column is decided by the same workflow
 * table the server validates against, so a refusal is explained rather than
 * discovered. A drop that needs input opens its dialog before anything is sent.
 */
export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const projects = useProjects();

  const projectId = params.get('projectId') ?? undefined;
  const showAll = params.get('all') === 'true';

  const query = useTaskList({ projectId, limit: 100 });
  const pages = query.data?.pages;
  // Counts come from the server, so a column header is the real total rather
  // than however many cards this page happened to load.
  const board = useBoardSummary({ projectId });
  const tasks = useMemo(() => pages?.flatMap((page) => page.items) ?? [], [pages]);

  const [dragging, setDragging] = useState<TaskSummary | null>(null);
  const [pending, setPending] = useState<{
    task: TaskSummary;
    to: TaskStatus;
    requires: TransitionRequirement[];
  } | null>(null);

  const transition = useTransitionTask(pending?.task.id);

  // A pointer must travel a little before a drag begins, or every click on a
  // card would be read as a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Which columns to hide is a shared decision, not a board-local one.
  const collapsed = board.data?.collapsed ?? COLLAPSED_BOARD_COLUMNS;
  const columns = showAll
    ? BOARD_COLUMNS
    : BOARD_COLUMNS.filter((status) => !collapsed.includes(status));

  const byStatus = useMemo(() => {
    const grouped = new Map<TaskStatus, TaskSummary[]>();
    for (const status of BOARD_COLUMNS) grouped.set(status, []);
    for (const task of tasks) grouped.get(task.status)?.push(task);
    return grouped;
  }, [tasks]);

  /** The workflow's verdict for this actor moving this card here. */
  function verdictFor(task: TaskSummary, to: TaskStatus) {
    if (!user) return { ok: false, reason: 'You are not signed in.' };
    return canTransition(task.status, to, {
      role: user.role,
      isAssignee: task.assignee?.id === user.id,
      isReviewer: task.reviewer?.id === user.id,
      isTeamLeadOfProject: user.ledTeamIds.length > 0,
    });
  }

  async function runTransition(task: TaskSummary, to: TaskStatus, extra: Record<string, unknown>) {
    try {
      await api.post<TaskDetail>('/tasks/' + task.id + '/transition', { to, ...extra });
      await query.refetch();
      setPending(null);
    } catch (error) {
      // The card snaps back because the cache never changed.
      toast.error(error instanceof ApiError ? error.message : 'That move failed.');
      setPending(null);
    }
  }

  function onDragEnd(event: DragEndEvent) {
    setDragging(null);

    const to = event.over?.id as TaskStatus | undefined;
    const task = tasks.find((t) => t.id === event.active.id);
    if (!to || !task || to === task.status) return;

    const verdict = verdictFor(task, to);
    if (!verdict.ok) {
      // Snap back, and say why rather than just refusing.
      toast.error(verdict.reason ?? 'That move is not allowed.');
      return;
    }

    if (verdict.requires && verdict.requires.length > 0) {
      // Ask first: the card stays where it was until the dialog is confirmed.
      setPending({ task, to, requires: verdict.requires });
      return;
    }

    void runTransition(task, to, {});
  }

  return (
    <div className="flex h-full flex-col gap-4 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Board</h1>

        <Select
          className="w-auto min-w-36"
          aria-label="Project"
          value={projectId ?? ''}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.currentTarget.value) next.set('projectId', e.currentTarget.value);
            else next.delete('projectId');
            setParams(next, { replace: true });
          }}
        >
          <option value="">All projects</option>
          {projects.data?.items.map((project) => (
            <option key={project.id} value={project.id}>
              {project.key}
            </option>
          ))}
        </Select>

        <Button
          variant="outline"
          size="sm"
          aria-pressed={showAll}
          onClick={() => {
            const next = new URLSearchParams(params);
            if (showAll) next.delete('all');
            else next.set('all', 'true');
            setParams(next, { replace: true });
          }}
        >
          {showAll ? <EyeOff size={14} /> : <Eye size={14} />}
          {showAll ? 'Hide backlog and cancelled' : 'Show backlog and cancelled'}
        </Button>
      </header>

      {query.isLoading ? (
        <div className="flex gap-3 overflow-x-auto">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-72 w-64 shrink-0" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <Card>
          <EmptyState title="No tasks on this board" description="Pick another project, or create one." />
        </Card>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={(event: DragStartEvent) =>
            setDragging(tasks.find((t) => t.id === event.active.id) ?? null)
          }
          onDragCancel={() => setDragging(null)}
          onDragEnd={onDragEnd}
        >
          <div className="flex flex-1 gap-3 overflow-x-auto pb-3">
            {columns.map((status) => (
              <Column
                key={status}
                status={status}
                tasks={byStatus.get(status) ?? []}
                total={board.data?.counts[status]}
                dragging={dragging}
                verdictFor={verdictFor}
              />
            ))}
          </div>

          <DragOverlay>{dragging ? <TaskCard task={dragging} overlay /> : null}</DragOverlay>
        </DndContext>
      )}

      {pending ? (
        <TransitionDialog
          to={pending.to}
          requires={pending.requires}
          busy={transition.isPending}
          error={null}
          onCancel={() => setPending(null)}
          onConfirm={(values) => void runTransition(pending.task, pending.to, values)}
        />
      ) : null}
    </div>
  );
}

function Column({
  status,
  tasks,
  total,
  dragging,
  verdictFor,
}: {
  status: TaskStatus;
  tasks: TaskSummary[];
  /** The server's count; falls back to the cards on screen while it loads. */
  total: number | undefined;
  dragging: TaskSummary | null;
  verdictFor(task: TaskSummary, to: TaskStatus): { ok: boolean; reason?: string };
}) {
  const { isOver, setNodeRef } = useDroppable({ id: status });

  // While a card is in the air, show which columns will accept it.
  const verdict = dragging ? verdictFor(dragging, status) : null;
  const rejects = Boolean(dragging) && dragging?.status !== status && verdict?.ok === false;

  return (
    <section
      ref={setNodeRef}
      aria-label={STATUS_LABELS[status]}
      data-status={status}
      data-droppable="true"
      className={cn(
        'flex w-64 shrink-0 flex-col rounded-card border bg-surface-muted/50 transition-colors',
        isOver && !rejects && 'border-accent bg-accent-soft/40',
        isOver && rejects && 'border-danger bg-danger-soft/40',
        !isOver && 'border-border-subtle',
        rejects && 'opacity-60',
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <h2 className="text-xs font-semibold">{STATUS_LABELS[status]}</h2>
        <span
          className="ml-auto rounded-md bg-surface px-1.5 text-xs tabular-nums text-ink-muted"
          data-testid={'count-' + status}
        >
          {total ?? tasks.length}
        </span>
        {rejects ? <Ban size={13} className="text-danger" aria-label="Not allowed here" /> : null}
      </header>

      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {tasks.map((task) => (
          <DraggableCard key={task.id} task={task} />
        ))}
      </div>
    </section>
  );
}

function DraggableCard({ task }: { task: TaskSummary }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn('touch-none', isDragging && 'opacity-40')}
    >
      <TaskCard task={task} />
    </div>
  );
}

function TaskCard({ task, overlay = false }: { task: TaskSummary; overlay?: boolean }) {
  return (
    <article
      data-task-key={task.key}
      className={cn(
        'rounded-lg border border-border-subtle bg-surface p-2.5',
        overlay && 'shadow-lg',
      )}
    >
      <div className="flex items-center gap-2">
        <Link
          to={'/tasks/' + task.key}
          className="font-mono text-[11px] text-accent hover:underline"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {task.key}
        </Link>
        {task.status === 'BLOCKED' ? (
          <Ban size={12} className="text-danger" aria-label="Blocked" />
        ) : null}
        <span className="ml-auto">
          <PriorityBadge priority={task.priority} />
        </span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-sm">{task.title}</p>

      <div className="mt-2 flex items-center gap-2">
        <UserAvatar user={task.assignee} size="sm" />
        <span className="ml-auto">
          <DueBadge dueDate={task.dueDate} status={task.status} />
        </span>
      </div>

      <ProgressBar value={task.progress} className="mt-2" />
    </article>
  );
}
