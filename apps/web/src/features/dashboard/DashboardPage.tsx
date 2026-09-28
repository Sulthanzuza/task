import { Link } from 'react-router-dom';
import type { AttentionItem, DashboardSummary } from '@tm/shared';
import { ATTENTION_REASON_LABELS } from '@tm/shared';
import { useAuth } from '@/features/auth/AuthContext';
import { useAttention, useDashboardMembers, useDashboardSummary } from './api';
import { Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { DueBadge, PriorityBadge, StatusBadge, UserAvatar } from '@/components/common/badges';
import { cn, relativeTime } from '@/lib/utils';

/**
 * Every number here links to the task list filtered the same way, so a lead can
 * always get from a count to the tasks behind it. Nothing is scored or ranked.
 */

interface Kpi {
  key: keyof DashboardSummary;
  label: string;
  to: string;
  tone?: 'danger' | 'warning' | 'accent';
}

const KPIS: Kpi[] = [
  { key: 'active', label: 'Active', to: '/tasks?open=true' },
  { key: 'dueToday', label: 'Due today', to: '/tasks?dueToday=true', tone: 'warning' },
  { key: 'overdue', label: 'Overdue', to: '/tasks?overdue=true', tone: 'danger' },
  { key: 'blocked', label: 'Blocked', to: '/tasks?blocked=true', tone: 'danger' },
  { key: 'waitingReview', label: 'Waiting review', to: '/tasks?status=READY_FOR_REVIEW,IN_REVIEW' },
  { key: 'noUpdate', label: 'No update', to: '/tasks?noUpdate=true', tone: 'warning' },
  { key: 'completedThisWeek', label: 'Done this week', to: '/tasks?status=COMPLETED' },
  { key: 'unassignedOpen', label: 'Unassigned', to: '/tasks?assigneeId=none&open=true' },
];

export function DashboardPage() {
  const { primaryTeamId } = useAuth();
  const summary = useDashboardSummary(primaryTeamId);
  const members = useDashboardMembers(primaryTeamId);
  const attention = useAttention(primaryTeamId);

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Team dashboard</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {summary.data
            ? 'As of ' + summary.data.asOfDate + ' in ' + summary.data.timezone
            : 'Loading the current picture…'}
        </p>
      </header>

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {KPIS.map((kpi) => (
          <KpiCard
            key={kpi.key}
            kpi={kpi}
            value={summary.data?.[kpi.key]}
            loading={summary.isLoading}
          />
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-5">
        <section aria-labelledby="attention-heading" className="lg:col-span-3">
          <h2 id="attention-heading" className="mb-2 text-sm font-semibold">
            Needs your attention
          </h2>
          <Card>
            {attention.isLoading ? (
              <div className="space-y-3 p-4">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-11 w-full" />
                ))}
              </div>
            ) : attention.data?.items.length ? (
              <ul className="divide-y divide-border-subtle">
                {attention.data.items.map((item) => (
                  <AttentionRow key={item.taskId + item.reason} item={item} />
                ))}
              </ul>
            ) : (
              <EmptyState
                title="Nothing needs chasing"
                description="No task is overdue, blocked, or sitting without an update."
              />
            )}
          </Card>
        </section>

        <section aria-labelledby="members-heading" className="lg:col-span-2">
          <h2 id="members-heading" className="mb-2 text-sm font-semibold">
            The team
          </h2>
          <Card>
            {members.isLoading ? (
              <div className="space-y-3 p-4">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : members.data?.items.length ? (
              <ul className="divide-y divide-border-subtle">
                {members.data.items.map((row) => (
                  <li key={row.user.id}>
                    <Link
                      to={'/team/' + row.user.id}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-muted"
                    >
                      <UserAvatar user={row.user} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{row.user.name}</p>
                        <p className="truncate text-xs text-ink-faint">
                          {row.lastActivityAt
                            ? 'Last update ' + relativeTime(row.lastActivityAt)
                            : 'No activity yet'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
                        <Stat label="active" value={row.active} />
                        <Stat label="overdue" value={row.overdue} tone="danger" />
                        <Stat label="blocked" value={row.blocked} tone="danger" />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No members yet" description="Add people to this team to see them here." />
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}

function KpiCard({ kpi, value, loading }: { kpi: Kpi; value: unknown; loading: boolean }) {
  const numeric = typeof value === 'number' ? value : 0;
  // Colour only carries meaning when there is something to look at.
  const highlight = numeric > 0 && kpi.tone;

  return (
    <Link to={kpi.to} className="group">
      <Card className="p-4 transition-colors group-hover:border-accent">
        <p className="text-xs font-medium text-ink-muted">{kpi.label}</p>
        {loading ? (
          <Skeleton className="mt-2 h-7 w-10" />
        ) : (
          <p
            className={cn(
              'mt-1 text-2xl font-semibold tabular-nums',
              highlight === 'danger' && 'text-danger',
              highlight === 'warning' && 'text-warning',
            )}
          >
            {numeric}
          </p>
        )}
      </Card>
    </Link>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'danger' }) {
  return (
    <span
      title={label}
      className={cn(
        'inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 font-medium',
        value > 0 && tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-surface-muted text-ink-muted',
      )}
    >
      {value}
    </span>
  );
}

const REASON_TONE: Record<AttentionItem['reason'], string> = {
  OVERDUE: 'bg-danger-soft text-danger',
  BLOCKED: 'bg-danger-soft text-danger',
  NO_UPDATE: 'bg-warning-soft text-warning',
  REVIEW_WAITING: 'bg-warning-soft text-warning',
  DUE_TODAY_LOW_PROGRESS: 'bg-info-soft text-info',
};

function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <li>
      <Link
        to={'/tasks/' + item.key}
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors hover:bg-surface-muted"
      >
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-medium',
            REASON_TONE[item.reason],
          )}
        >
          {ATTENTION_REASON_LABELS[item.reason]}
        </span>

        <span className="shrink-0 font-mono text-xs text-ink-faint">{item.key}</span>

        <span className="min-w-40 flex-1 truncate text-sm">{item.title}</span>

        <span className="shrink-0 text-xs text-ink-muted">{item.detail}</span>

        <span className="flex shrink-0 items-center gap-2">
          <PriorityBadge priority={item.priority} />
          <StatusBadge status={item.status} />
          <DueBadge dueDate={item.dueDate} status={item.status} />
          <UserAvatar user={item.assignee} size="sm" />
        </span>
      </Link>
    </li>
  );
}
