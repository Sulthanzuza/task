import type { BlockerType, TaskPriority, TaskStatus, UserSummary } from '@tm/shared';
import { BLOCKER_TYPE_LABELS, PRIORITY_LABELS, STATUS_LABELS } from '@tm/shared';
import { cn, formatDate, initials, todayIso } from '@/lib/utils';

/**
 * Status, priority and due date are read at a glance all day long, so each has
 * one fixed appearance used everywhere.
 */

const STATUS_TONE: Record<TaskStatus, string> = {
  BACKLOG: 'bg-neutral-soft text-ink-muted',
  ASSIGNED: 'bg-info-soft text-info',
  IN_PROGRESS: 'bg-accent-soft text-accent',
  BLOCKED: 'bg-danger-soft text-danger',
  READY_FOR_REVIEW: 'bg-warning-soft text-warning',
  IN_REVIEW: 'bg-warning-soft text-warning',
  CHANGES_REQUESTED: 'bg-danger-soft text-danger',
  COMPLETED: 'bg-success-soft text-success',
  CANCELLED: 'bg-neutral-soft text-ink-faint',
};

export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        STATUS_TONE[status],
        className,
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

const PRIORITY_TONE: Record<TaskPriority, string> = {
  LOW: 'text-ink-faint',
  MEDIUM: 'text-ink-muted',
  HIGH: 'text-warning',
  URGENT: 'text-danger',
};

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', PRIORITY_TONE[priority])}>
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full bg-current"
        style={{ opacity: priority === 'LOW' ? 0.5 : 1 }}
      />
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

/**
 * Red when overdue, amber when due today. The comparison uses the date string the
 * server sent, so it agrees with the org time zone rather than the browser's.
 */
export function DueBadge({
  dueDate,
  status,
  className,
}: {
  dueDate: string | null;
  status?: TaskStatus;
  className?: string;
}) {
  if (!dueDate) return <span className="text-xs text-ink-faint">—</span>;

  const closed = status === 'COMPLETED' || status === 'CANCELLED';
  const today = todayIso();
  const overdue = !closed && dueDate < today;
  const dueToday = !closed && dueDate === today;

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        overdue && 'bg-danger-soft text-danger',
        dueToday && 'bg-warning-soft text-warning',
        !overdue && !dueToday && 'text-ink-muted',
        className,
      )}
      title={overdue ? 'Overdue' : dueToday ? 'Due today' : undefined}
    >
      {formatDate(dueDate)}
    </span>
  );
}

export function BlockerBadge({ type }: { type: BlockerType | null }) {
  if (!type) return null;
  return (
    <span className="inline-flex items-center rounded-md bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">
      {BLOCKER_TYPE_LABELS[type]}
    </span>
  );
}

export function ProgressBar({
  value,
  className,
  showLabel = false,
}: {
  value: number;
  className?: string;
  showLabel?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full min-w-10 overflow-hidden rounded-full bg-surface-muted"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: clamped + '%' }}
        />
      </div>
      {showLabel ? (
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink-muted">{clamped}%</span>
      ) : null}
    </div>
  );
}

const AVATAR_TONES = [
  'bg-accent-soft text-accent',
  'bg-success-soft text-success',
  'bg-warning-soft text-warning',
  'bg-info-soft text-info',
  'bg-danger-soft text-danger',
];

function toneFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length] as string;
}

export function UserAvatar({
  user,
  size = 'md',
  showName = false,
}: {
  user: UserSummary | null;
  size?: 'sm' | 'md';
  showName?: boolean;
}) {
  if (!user) {
    return <span className="text-xs text-ink-faint">Unassigned</span>;
  }

  const dimension = size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-7 w-7 text-xs';

  return (
    <span className="inline-flex items-center gap-2">
      <span
        title={user.name}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full font-semibold',
          dimension,
          toneFor(user.id),
        )}
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
        ) : (
          initials(user.name)
        )}
      </span>
      {showName ? <span className="truncate text-sm text-ink">{user.name}</span> : null}
    </span>
  );
}

export function LabelChip({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium"
      style={{ backgroundColor: color + '22', color }}
    >
      {name}
    </span>
  );
}
