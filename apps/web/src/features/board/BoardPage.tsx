import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type ReactNode,
} from 'react';
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
import { Ban, ChevronLeft, ChevronRight, Eye, EyeOff, GripVertical, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { TaskDetail, TaskStatus, TaskSummary, TransitionRequirement } from '@tm/shared';
import {
  BLOCKER_TYPE_LABELS,
  BOARD_COLUMNS,
  COLLAPSED_BOARD_COLUMNS,
  STATUS_LABELS,
  canTransition,
  priorityColor,
  statusColor,
} from '@tm/shared';
import { useBoardSummary, useTaskList, useTransitionTask } from '@/features/tasks/api';
import { useProjects } from '@/features/team/api';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError, api } from '@/lib/api';
import { Button, Card, EmptyState, Select, Skeleton } from '@/components/ui/primitives';
import { DueBadge, PriorityIcon, ProgressBar, UserAvatar } from '@/components/common/badges';
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

  /*
   * Group containers are off the board by default. A column holding both a
   * group and each of its eight children shows the same piece of work nine
   * times, and dragging the container would mean nothing: its status is
   * read off its children, so the drop would be overwritten at once.
   */
  const showGroups = params.get('groups') === 'true';
  const query = useTaskList({ projectId, limit: 100, includeGroups: showGroups });
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

        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showGroups}
          onClick={() => {
            const next = new URLSearchParams(params);
            if (showGroups) next.delete('groups');
            else next.set('groups', 'true');
            setParams(next, { replace: true });
          }}
        >
          <Users size={14} aria-hidden />
          {showGroups ? 'Hide group rows' : 'Show group rows'}
        </Button>
      </header>

      {query.isLoading ? (
        <div className="flex gap-3 relative overflow-x-auto">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-72 w-64 shrink-0" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <Card>
          <EmptyState
            title="No tasks on this board"
            description="Pick another project, or create one."
          />
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
          {/*
            The strip scrolls, not the page. A board that moves the whole
            window sideways on a phone loses the top bar with it.
          */}
          <ColumnStrip>
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
          </ColumnStrip>

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
        // min-h-0 so the card list below can be the thing that scrolls;
        // without it a flex child refuses to shrink past its content.
        'flex max-h-full w-64 min-h-0 shrink-0 flex-col rounded-[var(--radius-card)] border backdrop-blur-sm transition-colors',
        'bg-surface/60',
        isOver && !rejects && 'border-accent bg-accent-soft/40',
        isOver && rejects && 'border-danger bg-danger-soft/40',
        !isOver && 'border-border-subtle',
        rejects && 'opacity-60',
      )}
    >
      {/* shrink-0, so the header stays put while its cards scroll under it. */}
      <header className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: statusColor(status) }}
        />
        <h2 className="text-xs font-semibold">{STATUS_LABELS[status]}</h2>
        <span
          className="tabular ml-auto rounded-full bg-surface-muted px-2 py-0.5 text-xs text-ink-muted"
          data-testid={'count-' + status}
        >
          {total ?? tasks.length}
        </span>
        {rejects ? <Ban size={13} className="text-danger" aria-label="Not allowed here" /> : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain px-2 pb-2">
        {tasks.map((task) => (
          <DraggableCard key={task.id} task={task} />
        ))}
      </div>
    </section>
  );
}

/**
 * Pointer drag from anywhere on the card, keyboard drag from the grip.
 *
 * Spreading dnd-kit's attributes over the whole card gave it role="button",
 * and the card holds a link to the task, so it became a button wrapping a
 * link: nothing inside could be reached by keyboard. Splitting the two keeps
 * the easy pointer target and gives the keyboard a real control to use.
 */
/** 256px, as w-64. The scroll buttons step by exactly one column. */
const COLUMN_WIDTH = 256;

/**
 * The horizontal strip, with something to say it goes on.
 *
 * Nine statuses do not fit any window, and a board whose columns simply stop
 * at the edge looks finished. A fade over the overflowing side and a pair of
 * buttons say there is more and give a way there that does not need a
 * trackpad gesture or a visible scrollbar.
 */
function ColumnStrip({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const max = node.scrollWidth - node.clientWidth;
    setEdges({ left: node.scrollLeft > 4, right: node.scrollLeft < max - 4 });
  }, []);

  useEffect(() => {
    measure();
    const node = ref.current;
    if (!node) return;
    // Columns appear and disappear as the filters change, so watch the box
    // rather than measuring once on mount.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, children]);

  const nudge = (direction: -1 | 1) => {
    // One column and its gap, so a press lands on a column boundary.
    ref.current?.scrollBy({ left: direction * (COLUMN_WIDTH + 12), behavior: 'smooth' });
  };

  return (
    <div className="relative">
      {/*
        The strip is as tall as what is left of the window, and each column
        scrolls inside it. With the page growing to fit the tallest column, a
        busy In progress made the board 4,300px tall: every other column
        header scrolled away, and the buttons for moving sideways ended up
        somewhere around the fold.
      */}
      <div
        ref={ref}
        onScroll={measure}
        className="relative flex max-h-[calc(100vh-11rem)] max-w-full flex-1 gap-3 overflow-x-auto overscroll-x-contain pb-3"
      >
        {children}
      </div>

      {/* Decoration over the edge; it must never eat a click on a card. */}
      {edges.left ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-[var(--color-canvas)] to-transparent"
        />
      ) : null}
      {edges.right ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-[var(--color-canvas)] to-transparent"
        />
      ) : null}

      {/*
        pointer-events-none on the row, auto on the buttons. Without it this
        strip is an invisible band across the middle of the board that
        swallows every drop aimed at a column behind it.
      */}
      {edges.left || edges.right ? (
        <div className="pointer-events-none absolute top-1/2 right-1 left-1 flex -translate-y-1/2 justify-between">
          <StripButton show={edges.left} label="Scroll the board left" onClick={() => nudge(-1)}>
            <ChevronLeft size={16} aria-hidden />
          </StripButton>
          <StripButton show={edges.right} label="Scroll the board right" onClick={() => nudge(1)}>
            <ChevronRight size={16} aria-hidden />
          </StripButton>
        </div>
      ) : null}
    </div>
  );
}

function StripButton({
  show,
  label,
  onClick,
  children,
}: {
  show: boolean;
  label: string;
  onClick(): void;
  children: ReactNode;
}) {
  if (!show) return <span />;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border border-border-subtle bg-surface text-ink shadow-lg transition-colors hover:border-border-strong"
    >
      {children}
    </button>
  );
}

function DraggableCard({ task }: { task: TaskSummary }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });

  // dnd-kit types its listeners as a bag of Function, since it does not know
  // which element they will land on.
  const startByPointer = listeners?.onPointerDown as
    PointerEventHandler<HTMLDivElement> | undefined;
  const startByKeyboard = listeners?.onKeyDown as
    KeyboardEventHandler<HTMLButtonElement> | undefined;

  return (
    <div
      ref={setNodeRef}
      onPointerDown={startByPointer}
      className={cn('touch-none', isDragging && 'opacity-40')}
    >
      <TaskCard
        task={task}
        handle={
          <button
            type="button"
            {...attributes}
            onKeyDown={startByKeyboard}
            title={'Move ' + task.key}
            aria-label={'Move ' + task.key + '. Press space, then the arrow keys.'}
            className="ml-auto cursor-grab rounded-md p-1 text-ink-faint hover:bg-surface-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <GripVertical size={13} aria-hidden />
          </button>
        }
      />
    </div>
  );
}

/** "Blocked 2d · Waiting on client". */
function blockedSummary(task: TaskSummary): string {
  const days = task.workingDaysBlocked;
  const age = days === null ? 'Blocked' : 'Blocked ' + Math.max(days, 1) + 'd';
  return task.blockerType ? age + ' \u00b7 ' + BLOCKER_TYPE_LABELS[task.blockerType] : age;
}

function TaskCard({
  task,
  overlay = false,
  handle,
}: {
  task: TaskSummary;
  overlay?: boolean;
  handle?: ReactNode;
}) {
  return (
    <article
      data-task-key={task.key}
      className={cn(
        // The stripe down the left is the priority, from the shared map, so a
        // glance across the column sorts the urgent from the rest.
        'relative overflow-hidden rounded-xl border border-border-subtle bg-surface p-2.5 pl-3',
        // The dragged card carries the accent glow rather than a grey shadow.
        overlay && 'shadow-[0_18px_40px_-12px_var(--color-accent)] ring-1 ring-accent',
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: priorityColor(task.priority) }}
      />

      <div className="flex items-center gap-2">
        {task.isGroup ? (
          <Users size={12} aria-label="Group task" className="shrink-0 text-accent" />
        ) : (
          <PriorityIcon priority={task.priority} size={12} />
        )}
        <Link
          to={'/tasks/' + task.key}
          className="font-mono text-[11px] text-accent hover:underline"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {task.key}
        </Link>
        {task.status === 'BLOCKED' ? (
          <Ban size={12} className="ml-auto text-danger" aria-label="Blocked" />
        ) : null}
        <span className={cn(task.status === 'BLOCKED' ? 'ml-1' : 'ml-auto')}>{handle}</span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-sm" title={task.title}>
        {task.title}
      </p>

      {/*
        A blocked card without the age and the cause is just a red card. How
        long it has been stuck and who it is stuck on is the whole reason a
        lead scans this column; the sentence itself goes in the tooltip,
        because it is usually too long for a card.
      */}
      {task.status === 'BLOCKED' ? (
        <p
          className="mt-1 truncate text-[11px] text-danger"
          title={task.blockedReason ?? undefined}
        >
          {blockedSummary(task)}
        </p>
      ) : null}

      <div className="mt-2 flex items-center gap-2">
        <UserAvatar user={task.assignee} size="sm" />
        <span className="ml-auto">
          {/* No date, nothing there: a dash on a card is noise. */}
          <DueBadge
            dueDate={task.dueDate}
            status={task.status}
            workingDaysLate={task.workingDaysLate}
            emptyLabel={null}
          />
        </span>
      </div>

      <ProgressBar value={task.progress} className="mt-2" />
    </article>
  );
}
