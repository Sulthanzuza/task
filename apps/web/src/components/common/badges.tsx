import { AlertTriangle, ArrowDown, ArrowUp, Minus } from 'lucide-react';
import type { BlockerType, TaskPriority, TaskStatus, UserSummary } from '@tm/shared';
import {
  BLOCKER_TYPE_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  priorityColor,
  statusColor,
  tintedPill,
} from '@tm/shared';
import { cn, formatDate, initials, relativeTime, todayIso } from '@/lib/utils';

/**
 * Status, priority and due date are read at a glance all day long, so each has
 * one fixed appearance used everywhere.
 *
 * Every one of these carries its word or an icon as well as its colour. Colour
 * alone would be unreadable to anyone who cannot separate these hues, and
 * unprintable in black and white.
 */

/**
 * One pill treatment, everywhere.
 *
 * The colour and the tint both come from the shared map, so a status looks
 * like the same kind of thing in every theme and on every screen, rather than
 * some getting a background and others none.
 */
export function StatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        className,
      )}
      style={tintedPill(statusColor(status))}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {STATUS_LABELS[status]}
    </span>
  );
}

/** An arrow as well as a colour, so the ranking survives a greyscale print. */
const PRIORITY_ICON: Record<TaskPriority, typeof ArrowUp> = {
  LOW: ArrowDown,
  MEDIUM: Minus,
  HIGH: ArrowUp,
  URGENT: AlertTriangle,
};

/**
 * The priority icon on its own, for rows too tight for the whole badge.
 *
 * Shares PRIORITY_ICON with the badge, so the arrow that means "urgent" in a
 * list means the same thing everywhere. It is labelled, because on its own the
 * icon is the only carrier of the meaning.
 */
export function PriorityIcon({ priority, size = 13 }: { priority: TaskPriority; size?: number }) {
  const Icon = PRIORITY_ICON[priority];
  return (
    <Icon
      size={size}
      role="img"
      aria-label={PRIORITY_LABELS[priority] + ' priority'}
      style={{ color: priorityColor(priority) }}
      className="shrink-0"
    />
  );
}

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const Icon = PRIORITY_ICON[priority];
  return (
    <span
      className="inline-flex items-center gap-1 text-xs font-medium"
      style={{ color: priorityColor(priority) }}
    >
      <Icon size={12} aria-hidden />
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
  workingDaysLate,
  emptyLabel = '\u2014',
  className,
}: {
  dueDate: string | null;
  status?: TaskStatus;
  /**
   * What to show when there is no due date. A bare em dash reads as a value
   * that failed to load rather than as a date nobody set, so the places with
   * room say so in words, and the places without it (a board card) pass null
   * and show nothing at all.
   */
  emptyLabel?: string | null;
  /**
   * Working days past the date, counted on the server against the
   * organisation's calendar. When it is given, the badge says how late the
   * task is rather than when it was due, which is the more useful fact and
   * the one a lead asks for first.
   */
  workingDaysLate?: number | null;
  className?: string;
}) {
  if (!dueDate) {
    if (emptyLabel === null) return null;
    return <span className={cn('text-xs text-ink-faint', className)}>{emptyLabel}</span>;
  }

  const closed = status === 'COMPLETED' || status === 'CANCELLED';
  const today = todayIso();
  const overdue = !closed && dueDate < today;
  const dueToday = !closed && dueDate === today;

  const late =
    overdue && workingDaysLate !== null && workingDaysLate !== undefined
      ? Math.max(1, Math.round(workingDaysLate))
      : null;

  const shown = late === null ? formatDate(dueDate) : late + 'd late';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        overdue && 'bg-danger-soft text-danger',
        dueToday && 'bg-warning-soft text-warning',
        !overdue && !dueToday && 'text-ink-muted',
        className,
      )}
      title={
        late === null
          ? overdue
            ? 'Overdue'
            : dueToday
              ? 'Due today'
              : undefined
          : 'Due ' + formatDate(dueDate) + ', ' + late + ' working days late'
      }
      /*
       * The state goes in the accessible name rather than a visually hidden
       * span. sr-only is absolutely positioned, and inside a wide scrolling
       * table its containing block is the viewport rather than the scroller,
       * so it escapes the clip and drags the whole page sideways.
       */
      aria-label={
        late === null
          ? formatDate(dueDate) + (overdue ? ', overdue' : dueToday ? ', due today' : '')
          : 'Due ' + formatDate(dueDate) + ', ' + late + ' working days late'
      }
    >
      {overdue ? <AlertTriangle size={11} aria-hidden /> : null}
      {shown}
    </span>
  );
}

/**
 * A relative time, marked so a screenshot can cover it.
 *
 * "2 hours ago" is correct and useless to a byte comparison: it changes
 * every run. data-time is what the capture masks, and the machine-readable
 * instant stays in dateTime where it belongs anyway.
 */
export function RelativeTime({
  iso,
  className,
}: {
  iso: string | null | undefined;
  className?: string;
}) {
  return (
    <time data-time dateTime={iso ?? undefined} className={className}>
      {relativeTime(iso)}
    </time>
  );
}

export function BlockerBadge({ type }: { type: BlockerType | null }) {
  if (!type) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2.5 py-0.5 text-xs font-medium text-danger">
      <AlertTriangle size={11} aria-hidden />
      {BLOCKER_TYPE_LABELS[type]}
    </span>
  );
}

export function ProgressBar({
  value,
  className,
  showLabel = false,
  label = 'Progress',
}: {
  value: number;
  className?: string;
  showLabel?: boolean;
  /**
   * A progressbar with no name is announced as a bare number. In a list of
   * tasks that is dozens of unlabelled percentages, so the name is not
   * optional; callers with better context override it.
   */
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={clamped + '% complete'}
        className="h-1.5 w-full min-w-10 overflow-hidden rounded-full bg-surface-muted"
      >
        <div
          className="accent-gradient h-full rounded-full transition-[width] duration-300"
          style={{ width: clamped + '%' }}
        />
      </div>
      {showLabel ? (
        <span className="tabular w-9 shrink-0 text-right text-xs text-ink-muted">{clamped}%</span>
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
  nameOnly,
}: {
  user: UserSummary | null;
  size?: 'sm' | 'md';
  showName?: boolean;
  /**
   * 'first' shows the given name only, for columns too narrow for both but
   * far too wide for a single initial. The full name stays in the title, so
   * two people sharing a first name are still tellable apart on hover.
   */
  nameOnly?: 'first';
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
      {showName ? (
        <span title={user.name} className="truncate text-sm text-ink">
          {nameOnly === 'first' ? (user.name.split(/\s+/)[0] ?? user.name) : user.name}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A label's colour is chosen by whoever made it, out of a picker, so it cannot
 * be trusted to be readable. Unlike a status, there is no token to tune: the
 * value comes from the database.
 *
 * So the colour identifies the label and the ink reads it. The dot and the
 * border carry the hue, the text stays on the theme's own ink, and a chip is
 * legible whatever colour somebody picked.
 */
export function LabelChip({ name, color }: { name: string; color: string }) {
  const tint = tintedPill(color);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium text-ink"
      style={{ backgroundColor: tint.backgroundColor, borderColor: tint.borderColor }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      {name}
    </span>
  );
}
