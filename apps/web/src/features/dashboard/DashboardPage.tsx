import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, FolderKanban, Minus } from 'lucide-react';
import type { AttentionItem, DashboardCharts, DashboardSummary, MemberRow } from '@tm/shared';
import type { TaskPriority, TaskStatus } from '@tm/shared';
import { ATTENTION_REASON_LABELS, PRIORITY_ORDER, priorityColor, statusColor } from '@tm/shared';
import { useAttention, useDashboardCharts, useDashboardMembers, useDashboardSummary } from './api';
import { useAuth } from '@/features/auth/AuthContext';
import { usePeriod } from '@/app/PeriodSwitcher';
import {
  AreaTrend,
  Donut,
  DonutLegend,
  GradientBars,
  Heatmap,
  RadarShape,
  RingGauge,
  Sparkline,
  ThinProgress,
  type Datum,
  type HeatCell,
} from '@/components/charts';
import {
  Card,
  CardHeader,
  EmptyState,
  Figure,
  FigureLabel,
  HeroCard,
  SegmentedTabs,
  Skeleton,
} from '@/components/ui/primitives';
import {
  DueBadge,
  PriorityIcon,
  ProgressBar,
  StatusBadge,
  UserAvatar,
} from '@/components/common/badges';
import { cn } from '@/lib/utils';

/**
 * The team dashboard.
 *
 * Every number on this page comes from the dashboard service or the shared
 * predicates, and every one of them links to the task list filtered to the
 * same rule, so a figure and the list behind it can never tell two stories.
 *
 * Nothing here scores or ranks a person. The team table reports what each
 * person is carrying; it does not grade them for it.
 */

/** The counted fields only: asOfDate and timezone are not KPIs. */
type CountKey = Exclude<keyof DashboardSummary, 'asOfDate' | 'timezone'>;

/** "Wed 30 Sep": the date as somebody would say it, not as a database stores it. */
function readableDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(iso + 'T00:00:00Z'));
}

interface Kpi {
  key: CountKey;
  label: string;
  to: string;
  tone?: 'danger' | 'warning';
}

/*
 * Six, not eight. Active and Done this week are the hero's own figures, with
 * the trend beside them; repeating them here would be two answers to the same
 * question sitting side by side.
 */
const KPIS: Kpi[] = [
  { key: 'dueToday', label: 'Due today', to: '/tasks?dueToday=true', tone: 'warning' },
  { key: 'overdue', label: 'Overdue', to: '/tasks?overdue=true', tone: 'danger' },
  { key: 'blocked', label: 'Blocked', to: '/tasks?blocked=true', tone: 'danger' },
  { key: 'waitingReview', label: 'Waiting review', to: '/tasks?status=READY_FOR_REVIEW,IN_REVIEW' },
  { key: 'noUpdate', label: 'No update', to: '/tasks?noUpdate=true', tone: 'warning' },
  { key: 'unassignedOpen', label: 'Unassigned', to: '/tasks?assigneeId=none&open=true' },
];

/** Every KPI destination, including the two the hero owns. Used by the tests. */
export const KPI_LINKS = [
  { label: 'Active', to: '/tasks?active=true' },
  { label: 'Done this week', to: '/tasks?completedThisWeek=true' },
  ...KPIS.map((kpi) => ({ label: kpi.label, to: kpi.to })),
];

export function DashboardPage() {
  const { primaryTeamId } = useAuth();
  const { period } = usePeriod();

  const summary = useDashboardSummary(primaryTeamId);
  const members = useDashboardMembers(primaryTeamId);
  const attention = useAttention(primaryTeamId);
  const charts = useDashboardCharts(primaryTeamId, period);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Team dashboard</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {summary.data
            ? readableDate(summary.data.asOfDate) + ' · ' + summary.data.timezone
            : 'Loading the current picture…'}
        </p>
      </header>

      <KeyNumbers summary={summary.data} charts={charts.data} loading={summary.isLoading} />

      {/* Row 1 */}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-4">
          <Hero summary={summary.data} charts={charts.data} loading={summary.isLoading} />
        </div>
        <div className="min-w-0 lg:col-span-5">
          <Throughput charts={charts.data} loading={charts.isLoading} />
        </div>
        <div className="min-w-0 lg:col-span-3">
          <WorkMix charts={charts.data} loading={charts.isLoading} />
        </div>
      </div>

      {/* Row 2 */}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-4">
          <Projects charts={charts.data} loading={charts.isLoading} />
        </div>
        <div className="min-w-0 lg:col-span-5">
          <StatusMix charts={charts.data} summary={summary.data} loading={charts.isLoading} />
        </div>
        <div className="min-w-0 lg:col-span-3">
          <PriorityMix charts={charts.data} loading={charts.isLoading} />
        </div>
      </div>

      {/* Row 3 */}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-5">
          <Compare charts={charts.data} loading={charts.isLoading} />
        </div>
        <div className="min-w-0 lg:col-span-7">
          <Attention
            items={attention.data?.items}
            total={attention.data?.total}
            loading={attention.isLoading}
          />
        </div>
      </div>

      {/* Row 4 */}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-5">
          <TeamTable rows={members.data?.items} loading={members.isLoading} />
        </div>
        <div className="min-w-0 lg:col-span-7">
          <DueLoad charts={charts.data} loading={charts.isLoading} />
        </div>
      </div>
    </div>
  );
}

/**
 * The eight headline counts, as compact pills.
 *
 * Every one is a link to the list it was counted from, which is what a lead
 * reaches for first. Only "Done this week" carries a trend, because it is the
 * only one of the eight with a previous period to compare against; an arrow
 * on the others would be decoration pretending to be information.
 */
function KeyNumbers({
  summary,
  charts,
  loading,
}: {
  summary: DashboardSummary | undefined;
  charts: DashboardCharts | undefined;
  loading: boolean;
}) {
  if (loading) return <Skeleton className="h-[72px] w-full" />;

  const trendFor = (key: CountKey): number | null => {
    if (key !== 'completedThisWeek' || !charts) return null;
    return charts.completedThisWeek - charts.completedLastWeek;
  };

  return (
    <section
      aria-label="Key numbers"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
    >
      {KPIS.map((kpi) => {
        const value = summary?.[kpi.key] ?? 0;
        const trend = trendFor(kpi.key);

        return (
          <Link
            key={kpi.key}
            to={kpi.to}
            aria-label={kpi.label + ': ' + String(value)}
            className="group flex min-w-0 items-center gap-2.5 rounded-full border border-border-subtle bg-surface py-2 pr-3 pl-2 transition-all hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[var(--shadow-lift)]"
          >
            <span
              className={cn(
                'tabular flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                kpi.tone === 'danger' && value > 0
                  ? 'bg-danger-soft text-danger'
                  : kpi.tone === 'warning' && value > 0
                    ? 'bg-warning-soft text-warning'
                    : 'bg-accent-soft text-accent',
              )}
            >
              {summary ? String(value) : '—'}
            </span>

            <span className="min-w-0 flex-1">
              <span className="block text-[11px] leading-tight text-ink-muted">{kpi.label}</span>
              {trend === null ? null : (
                <span
                  className={cn(
                    'mt-0.5 flex items-center gap-0.5 text-[11px] leading-tight font-medium',
                    trend > 0 && 'text-success',
                    trend < 0 && 'text-danger',
                    trend === 0 && 'text-ink-faint',
                  )}
                >
                  {trend > 0 ? <ArrowUpRight size={11} aria-hidden /> : null}
                  {trend < 0 ? <ArrowDownRight size={11} aria-hidden /> : null}
                  {trend === 0 ? <Minus size={11} aria-hidden /> : null}
                  {trend > 0 ? '+' : ''}
                  {trend}
                </span>
              )}
            </span>
          </Link>
        );
      })}
    </section>
  );
}

/** The dark card: what the team is carrying, and whether it is keeping up. */
function Hero({
  summary,
  charts,
  loading,
}: {
  summary: DashboardSummary | undefined;
  charts: DashboardCharts | undefined;
  loading: boolean;
}) {
  if (loading || !summary) return <Skeleton className="h-64 w-full" />;

  const thisWeek = charts?.completedThisWeek ?? summary.completedThisWeek;

  /*
   * Compared with the same point last week, not with all of it. Three days
   * against a full seven makes every Wednesday look like a collapse.
   */
  const soFar = charts?.weekToDate.completed ?? thisWeek;
  const before = charts?.weekToDate.completedLastWeek ?? 0;
  const change = soFar - before;

  const completions = (charts?.weekly ?? []).map((point) => point.completed);
  // Three markers, as in the reference: the ends and the middle of the run.
  const markers =
    completions.length >= 3
      ? [0, Math.floor((completions.length - 1) / 2), completions.length - 1]
      : completions.map((_, index) => index);

  return (
    // .hero-surface carries its own ink and accent, because the card stays
    // dark while the page around it may not.
    <HeroCard className="flex h-full flex-col">
      <FigureLabel className="text-ink-muted">Active tasks</FigureLabel>

      <div className="mt-1 flex items-end justify-between gap-3">
        <Link
          to="/tasks?active=true"
          aria-label={'Active: ' + summary.active}
          className="hover:underline"
        >
          <Figure value={summary.active} className="text-ink" />
        </Link>

        <RingGauge
          value={(charts?.onTimeRate ?? 0) * 100}
          label="On-time rate"
          size={76}
          caption="On time"
        />
      </div>

      <div className="mt-4">
        <Link
          to="/tasks?completedThisWeek=true"
          aria-label={'Done this week: ' + thisWeek}
          className="text-sm text-ink hover:underline"
        >
          <span className="tabular font-semibold">{thisWeek}</span> completed this week
        </Link>

        <span
          className={cn(
            'mt-1 flex items-center gap-1 text-xs font-medium',
            change > 0 && 'text-success',
            change < 0 && 'text-danger',
            change === 0 && 'text-ink-muted',
          )}
          title={
            soFar +
            ' by ' +
            (charts?.weekToDate.throughWeekday ?? 'today') +
            ' this week against ' +
            before +
            ' by the same point last week'
          }
        >
          {change > 0 ? <ArrowUpRight size={13} aria-hidden /> : null}
          {change < 0 ? <ArrowDownRight size={13} aria-hidden /> : null}
          {change === 0 ? <Minus size={13} aria-hidden /> : null}
          {change > 0 ? '+' : ''}
          {change} vs same time last week
        </span>
      </div>

      <div className="mt-auto pt-3">
        <Sparkline data={completions} markers={markers} />
        <p className="text-[11px] text-ink-muted">
          Weekly completions, last {completions.length} weeks
        </p>
      </div>
    </HeroCard>
  );
}

const THROUGHPUT_TABS = [
  { value: 'created' as const, label: 'Created' },
  { value: 'completed' as const, label: 'Completed' },
  { value: 'overdue' as const, label: 'Overdue' },
];

type ThroughputKey = (typeof THROUGHPUT_TABS)[number]['value'];

/** Twelve weekly bars, with the chosen period picked out in the accent. */
function Throughput({
  charts,
  loading,
}: {
  charts: DashboardCharts | undefined;
  loading: boolean;
}) {
  const [tab, setTab] = useState<ThroughputKey>('completed');

  const data: Datum[] = (charts?.weekly ?? []).map((point) => ({
    label: point.label,
    value: point[tab],
  }));

  /*
   * The weeks of the chosen period take the accent; the one still running is
   * hatched on top of that, so the period reads as a block and the unfinished
   * week is still marked as incomplete.
   */
  const highlightFrom = Math.max(0, data.length - (charts?.highlightWeeks ?? 4));
  const total = data.reduce((sum, point) => sum + point.value, 0);
  const inPeriod = data.slice(highlightFrom).reduce((sum, point) => sum + point.value, 0);

  return (
    <Card className="h-full">
      <CardHeader
        title="Throughput"
        subtitle="Twelve weeks"
        action={
          <div className="flex items-center gap-3">
            <span
              className="tabular text-sm font-semibold"
              title={inPeriod + ' in the chosen period'}
            >
              {total}
            </span>
            <SegmentedTabs
              label="Throughput measure"
              options={THROUGHPUT_TABS}
              value={tab}
              onChange={(next) => setTab(next)}
            />
          </div>
        }
      />
      <GradientBars
        data={data}
        highlightFrom={highlightFrom}
        loading={loading}
        height={200}
        partialLast
      />
    </Card>
  );
}

/** Which kinds of work are open, by label. */
function WorkMix({ charts, loading }: { charts: DashboardCharts | undefined; loading: boolean }) {
  const data: Datum[] = (charts?.labelMix ?? []).map((slice) => ({
    label: slice.label,
    value: slice.count,
    href: '/tasks?labelId=' + slice.key + '&open=true',
  }));

  return (
    <Card className="h-full">
      <CardHeader title="Work mix" subtitle="Open tasks by label" />
      <RadarShape data={data} loading={loading} height={200} />
    </Card>
  );
}

/** Each project, and how much of it is done. */
function Projects({ charts, loading }: { charts: DashboardCharts | undefined; loading: boolean }) {
  const projects = charts?.projects ?? [];
  const done = projects.reduce((sum, project) => sum + project.done, 0);
  const total = projects.reduce((sum, project) => sum + project.total, 0);
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <Card className="h-full">
      <CardHeader
        title="Projects"
        subtitle={done + ' / ' + total + ' done'}
        action={<span className="tabular text-sm font-semibold">{percent}%</span>}
      />

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState title="No projects yet" description="Create one to give tasks a home." />
      ) : (
        <ul className="space-y-3">
          {projects.map((project) => {
            const share =
              project.total === 0 ? 0 : Math.round((project.done / project.total) * 100);
            return (
              <li key={project.projectId}>
                <Link
                  to={'/tasks?projectId=' + project.projectId}
                  className="group flex items-center gap-2.5"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-surface-muted text-ink-muted">
                    <FolderKanban size={15} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm group-hover:underline">{project.name}</span>
                      <span className="tabular shrink-0 text-xs text-ink-muted">
                        {project.done}/{project.total}
                      </span>
                    </span>
                    <span className="mt-1.5 flex items-center gap-2">
                      <ThinProgress value={share} label={project.name + ' progress'} />
                      <span className="tabular w-9 shrink-0 text-right text-xs text-ink-muted">
                        {share}%
                      </span>
                    </span>
                    <span className="mt-1 flex gap-3 text-[11px] text-ink-faint">
                      <span>
                        <span className="tabular font-medium text-ink-muted">{project.open}</span>{' '}
                        open
                      </span>
                      <span className={project.overdue > 0 ? 'text-danger' : undefined}>
                        <span className="tabular font-medium">{project.overdue}</span> overdue
                      </span>
                      <span>
                        <span className="tabular font-medium text-ink-muted">
                          {project.dueThisWeek}
                        </span>{' '}
                        due this week
                      </span>
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Open work by status, with the two that need chasing called out beside it. */
function StatusMix({
  charts,
  summary,
  loading,
}: {
  charts: DashboardCharts | undefined;
  summary: DashboardSummary | undefined;
  loading: boolean;
}) {
  // The same colour the badge uses, from the shared map.
  const data: Datum[] = (charts?.statusBreakdown ?? []).map((slice) => ({
    label: slice.label,
    value: slice.count,
    colour: statusColor(slice.key as TaskStatus),
    href: '/tasks?status=' + slice.key,
  }));

  const open = data.reduce((sum, slice) => sum + slice.value, 0);
  const blocked = summary?.blocked ?? 0;
  const waiting = summary?.waitingReview ?? 0;

  return (
    <Card className="h-full">
      <CardHeader title="Status" subtitle="Open tasks" />

      <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
        <Donut data={data} centreValue={open} centreLabel="Open" loading={loading} size={150} />
        <DonutLegend data={data} />
      </div>

      <div className="mt-4 space-y-2 border-t border-border-subtle pt-3">
        <SidePanelRow
          label="Blocked"
          value={blocked}
          of={open}
          tone="var(--color-status-blocked)"
          to="/tasks?blocked=true"
        />
        <SidePanelRow
          label="Waiting review"
          value={waiting}
          of={open}
          tone="var(--color-status-review-ready)"
          to="/tasks?status=READY_FOR_REVIEW,IN_REVIEW"
        />
      </div>
    </Card>
  );
}

function SidePanelRow({
  label,
  value,
  of,
  tone,
  to,
}: {
  label: string;
  value: number;
  of: number;
  tone: string;
  to: string;
}) {
  const percent = of === 0 ? 0 : Math.round((value / of) * 100);
  return (
    <Link to={to} className="flex items-center gap-2 text-xs hover:underline">
      <span className="w-24 shrink-0 text-ink-muted">{label}</span>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted">
        <span
          className="block h-full rounded-full"
          style={{ width: percent + '%', background: tone }}
        />
      </span>
      <span className="tabular w-10 shrink-0 text-right font-medium">{value}</span>
      <span className="tabular w-9 shrink-0 text-right text-ink-muted">{percent}%</span>
    </Link>
  );
}

/** Open work by priority. */
function PriorityMix({
  charts,
  loading,
}: {
  charts: DashboardCharts | undefined;
  loading: boolean;
}) {
  /*
   * Severity order, not size order. A legend that reshuffles itself as the
   * counts move cannot be read at a glance, and Urgent belongs at the top
   * whether there are twenty of them or none.
   */
  const bySeverity = [...(charts?.priorityMix ?? [])].sort(
    (a, b) =>
      PRIORITY_ORDER.indexOf(a.key as TaskPriority) - PRIORITY_ORDER.indexOf(b.key as TaskPriority),
  );

  const data: Datum[] = bySeverity.map((slice) => ({
    label: slice.label,
    value: slice.count,
    colour: priorityColor(slice.key as TaskPriority),
    href: '/tasks?priority=' + slice.key + '&open=true',
  }));

  const total = data.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <Card className="h-full">
      <CardHeader title="Priority" subtitle="Open tasks" />
      <Donut data={data} centreValue={total} centreLabel="Total" loading={loading} size={140} />
      <div className="mt-3">
        <DonutLegend data={data} />
      </div>
    </Card>
  );
}

/** Created against completed, week by week. */
function Compare({ charts, loading }: { charts: DashboardCharts | undefined; loading: boolean }) {
  const data = (charts?.weekly ?? []).map((point) => ({
    label: point.label,
    a: point.created,
    b: point.completed,
  }));

  return (
    <Card className="flex h-full flex-col">
      <CardHeader title="Created against completed" subtitle="Twelve weeks" />
      {/* Stretches to the card rather than leaving a pale gap beneath it. */}
      <div className="min-h-0 flex-1">
        <AreaTrend
          data={data}
          seriesA={{ key: 'created', label: 'Created' }}
          seriesB={{ key: 'completed', label: 'Completed' }}
          loading={loading}
          height={330}
          partialLast
        />
      </div>
    </Card>
  );
}

/**
 * The attention list.
 *
 * A fixed grid rather than a wrapping flex row, so the eye can run down a
 * column: the key, the lateness and the status each sit in the same place on
 * every row. Only the title is elastic.
 */
function Attention({
  items,
  total,
  loading,
}: {
  items: AttentionItem[] | undefined;
  total: number | undefined;
  loading: boolean;
}) {
  const shown = items ?? [];
  const all = total ?? shown.length;

  return (
    <Card className="h-full" padded={false}>
      <div className="p-5 pb-3">
        <CardHeader
          title="Needs your attention"
          subtitle={all > shown.length ? 'Showing ' + shown.length + ' of ' + all : all + ' in all'}
          action={
            <Link to="/tasks?overdue=true" className="text-xs text-accent hover:underline">
              View all
            </Link>
          }
          className="mb-0"
        />
      </div>

      {loading ? (
        <div className="space-y-2 px-5 pb-5">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          title="Nothing needs chasing"
          description="No overdue, blocked or stale work."
        />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {shown.map((item) => (
            <li key={item.taskId}>
              <Link
                to={'/tasks/' + item.key}
                className={cn(
                  'items-center gap-x-3 px-5 py-2.5 transition-colors hover:bg-surface-muted',
                  /*
                   * A fixed grid from md up, so the eye can run down a column.
                   * Narrower than that the columns cannot all fit, and fixed
                   * tracks would push the card past the window, so the row
                   * wraps instead.
                   */
                  'flex flex-wrap gap-y-1.5',
                  'md:grid md:grid-cols-[24px_56px_minmax(0,1fr)_auto_64px_72px_auto] md:gap-y-0',
                )}
              >
                <UserAvatar user={item.assignee} size="sm" />
                <span className="flex items-center gap-1.5">
                  <PriorityIcon priority={item.priority} />
                  <span className="font-mono text-xs text-ink-faint">{item.key}</span>
                </span>
                <span className="truncate text-sm" title={item.title}>
                  {item.title}
                </span>
                <ReasonChip item={item} />
                <ProgressBar value={item.progress} />
                <LateOrDue item={item} />
                <StatusBadge status={item.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * The reason, unless the "late" column already says it.
 *
 * "Overdue" beside "12d late" is the same fact twice, and the row has better
 * uses for the width.
 */
function ReasonChip({ item }: { item: AttentionItem }) {
  if (item.reason === 'OVERDUE') return <span />;

  return (
    <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-warning">
      {ATTENTION_REASON_LABELS[item.reason]}
    </span>
  );
}

/**
 * How late it is, in working days, or when it is due.
 *
 * magnitude already holds the working days overdue, counted on the server
 * against the organisation's calendar; recomputing it here from a date would
 * quietly ignore weekends and holidays.
 */
function LateOrDue({ item }: { item: AttentionItem }) {
  if (item.reason === 'OVERDUE') {
    const days = Math.max(1, Math.round(item.magnitude));
    return (
      <span
        className="text-right text-xs font-medium whitespace-nowrap text-danger"
        title={item.detail}
      >
        {days}d late
      </span>
    );
  }

  return (
    <span className="text-right">
      <DueBadge dueDate={item.dueDate} status={item.status} />
    </span>
  );
}

/**
 * What each person is carrying.
 *
 * Counts and a bar, never a score. The bar shows how much of the team's open
 * work sits with this person, which is a fact about distribution rather than a
 * judgement about them.
 */
function TeamTable({ rows, loading }: { rows: MemberRow[] | undefined; loading: boolean }) {
  const people = rows ?? [];

  return (
    <Card className="h-full" padded={false}>
      <div className="p-5 pb-3">
        <CardHeader title="The team" subtitle={people.length + ' people'} className="mb-0" />
      </div>

      {loading ? (
        <div className="space-y-2 px-5 pb-5">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      ) : people.length === 0 ? (
        <EmptyState title="Nobody on this team yet" />
      ) : (
        <div className="relative">
          <table className="w-full table-fixed text-sm">
            <caption className="sr-only">Open work by person</caption>
            <colgroup>
              <col />
              <col className="w-16" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-28" />
            </colgroup>
            <thead>
              <tr className="border-b border-border-subtle text-left text-[11px] text-ink-faint">
                <th scope="col" className="px-4 py-2 font-medium">
                  Person
                </th>
                <th scope="col" className="px-1.5 py-2 text-right font-medium">
                  Active
                </th>
                <th scope="col" className="px-1.5 py-2 text-right font-medium">
                  Overdue
                </th>
                <th scope="col" className="px-1.5 py-2 text-right font-medium">
                  Blocked
                </th>
                {/*
                  Renamed from "Done", which did not say over what period.
                  Share used to follow: it drew the Active count as a bar and
                  then printed the same number beside it, so it said one thing
                  twice. A load percentage takes that place with Prompt 14.
                */}
                <th scope="col" className="px-4 py-2 text-right font-medium whitespace-nowrap">
                  Done this week
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {people.map((row) => (
                <tr key={row.user.id} className="transition-colors hover:bg-surface-muted">
                  <td className="px-4 py-2.5">
                    <Link
                      to={'/team/' + row.user.id}
                      className="flex items-center gap-2.5"
                      title={row.user.name + ' · ' + row.user.email}
                    >
                      <UserAvatar user={row.user} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm hover:underline">
                          {row.user.name}
                        </span>
                        <span className="block truncate text-[11px] text-ink-faint">
                          {row.user.email}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <Count
                    value={row.active}
                    to={'/tasks?assigneeId=' + row.user.id + '&active=true'}
                  />
                  <Count
                    value={row.overdue}
                    tone="danger"
                    to={'/tasks?assigneeId=' + row.user.id + '&overdue=true'}
                  />
                  <Count
                    value={row.blocked}
                    tone="danger"
                    to={'/tasks?assigneeId=' + row.user.id + '&blocked=true'}
                  />
                  <Count
                    value={row.completedThisWeek}
                    to={'/tasks?assigneeId=' + row.user.id + '&completedThisWeek=true'}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Count({ value, to, tone }: { value: number; to: string; tone?: 'danger' }) {
  return (
    <td className="px-1.5 py-2.5 text-right">
      <Link
        to={to}
        className={cn(
          'tabular text-sm hover:underline',
          tone === 'danger' && value > 0 && 'font-medium text-danger',
        )}
      >
        {value}
      </Link>
    </td>
  );
}

/** Hours due per person over the next ten days. */
function DueLoad({ charts, loading }: { charts: DashboardCharts | undefined; loading: boolean }) {
  const load = charts?.dueLoad;

  const rows = (load?.people ?? []).map((person) => ({ id: person.id, label: person.name }));
  const columns = (load?.days ?? []).map((day) => ({
    id: day.date,
    label: day.label,
    sublabel: day.weekday,
    title: day.holiday
      ? day.holiday + ' — not a working day'
      : day.working
        ? undefined
        : 'Weekend — not a working day',
  }));

  // More due in a day than there are hours in one: worth an outline.
  const dayHours = charts?.workHoursPerDay ?? 8;

  const cells: Record<string, Record<string, HeatCell>> = {};
  for (const person of load?.people ?? []) {
    cells[person.id] = {};
    for (const day of load?.days ?? []) {
      cells[person.id]![day.date] = { value: 0, disabled: !day.working };
    }
  }
  for (const cell of load?.cells ?? []) {
    const row = cells[cell.userId];
    if (!row) continue;
    const day = load?.days.find((entry) => entry.date === cell.date);
    const nonWorking = day ? !day.working : false;

    /*
     * Anything due on a day nobody works is worth flagging however small it
     * is: somebody has to move it or give up their Saturday.
     */
    row[cell.date] = {
      value: cell.hours,
      disabled: nonWorking,
      over: nonWorking ? cell.hours > 0 : cell.hours > dayHours,
      ...(nonWorking && cell.hours > 0
        ? { note: day?.holiday ? 'Due on a holiday: ' + day.holiday : 'Due on a weekend' }
        : {}),
      tooltip: cell.tasks.map((task) => task.key + ' ' + task.title + ' (' + task.hours + 'h)'),
    };
  }

  return (
    <Card className="h-full">
      <CardHeader
        title="Due load"
        subtitle={
          'Estimated hours due, next ten days. Hatched days are weekends and holidays; ' +
          'an outline means more than ' +
          dayHours +
          ' hours fall on one day.'
        }
      />
      {!loading && rows.length === 0 ? (
        <EmptyState title="Nobody on this team yet" />
      ) : (
        <Heatmap
          rows={rows}
          columns={columns}
          cells={cells}
          loading={loading}
          unit="h"
          rowHref={(id) => '/team/' + id}
        />
      )}
    </Card>
  );
}
