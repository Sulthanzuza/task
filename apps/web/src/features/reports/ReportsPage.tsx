import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, TrendingDown, TrendingUp } from 'lucide-react';
import type { CycleTimePoint, Report, ReportMetric, ReportQuery } from '@tm/shared';
import {
  BLOCKER_TYPE_LABELS,
  REPORT_PRESETS,
  REPORT_PRESET_LABELS,
  type ReportPreset,
} from '@tm/shared';
import { useAuth } from '@/features/auth/AuthContext';
import { useLabels, useProjects, useTeams, useUsers } from '@/features/team/api';
import { AreaTrend, BarList, GradientBars, SimpleLine } from '@/components/charts';
import { DueBadge, StatusBadge, UserAvatar } from '@/components/common/badges';
import { DataTable, Truncated, type Column } from '@/components/common/table';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Figure,
  FigureLabel,
  Input,
  Label,
  Select,
  Skeleton,
} from '@/components/ui/primitives';
import { reportExportHref, useReport } from './api';
import { cn, formatDate } from '@/lib/utils';

/**
 * Reports: what happened over a range somebody chose.
 *
 * Facts per metric and nothing else. There are no scores and no rankings
 * anywhere on this page, and the People table is sorted by name for that
 * reason: a list of colleagues ordered by a number invites a conclusion the
 * number cannot support.
 *
 * Every figure is a link. A lead who does not believe a number should be one
 * click from the rows that produced it, and the drill-downs carry the same
 * filters the report used, so the list and the number agree.
 */

const COMPARE_HINT = 'vs the previous period of the same length';

/** The filters, read from and written to the URL so a report can be shared. */
function useFilters(): [ReportQuery, (next: Partial<ReportQuery>) => void] {
  const [params, setParams] = useSearchParams();

  const query = useMemo<ReportQuery>(() => {
    const preset = (params.get('preset') ?? 'last4Weeks') as ReportPreset;
    return {
      preset: REPORT_PRESETS.includes(preset) ? preset : 'last4Weeks',
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      teamId: params.get('teamId') ?? undefined,
      projectId: params.get('projectId') ?? undefined,
      assigneeId: params.get('assigneeId') ?? undefined,
      labelId: params.get('labelId') ?? undefined,
    };
  }, [params]);

  const update = (next: Partial<ReportQuery>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === '') merged.delete(key);
      else merged.set(key, String(value));
    }
    setParams(merged, { replace: true });
  };

  return [query, update];
}

export function ReportsPage() {
  const { isAdmin } = useAuth();
  const [query, setQuery] = useFilters();

  const teams = useTeams();
  const projects = useProjects();
  const people = useUsers();
  const labels = useLabels(query.projectId);

  /*
   * A custom range is incomplete the moment it is chosen: the preset is in
   * the URL and the dates are not. Asking for it would be a request the API
   * is right to refuse, so the page asks for the dates instead.
   */
  const needsDates = query.preset === 'custom' && (!query.from || !query.to);
  const report = useReport(query, { enabled: !needsDates });

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {REPORT_PRESET_LABELS[query.preset]}
            {report.data
              ? ' · ' +
                formatDate(report.data.range.from) +
                ' to ' +
                formatDate(report.data.range.to) +
                ' · ' +
                report.data.range.timezone
              : null}
          </p>
        </div>

        <div className={cn('flex gap-2', report.data ? '' : 'hidden')}>
          {/*
            Plain links, not fetches: the browser's own download handling is
            better than anything rebuilt here, and the file is the response.
          */}
          <Button variant="outline" size="sm" asChild>
            <a href={reportExportHref(query, 'csv')}>
              <Download size={13} aria-hidden /> CSV
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={reportExportHref(query, 'xlsx')}>
              <Download size={13} aria-hidden /> Excel
            </a>
          </Button>
        </div>
      </header>

      {/* ------------------------------------------------------- filters */}
      <Card className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div>
          <Label htmlFor="preset">Range</Label>
          <Select
            id="preset"
            value={query.preset}
            onChange={(event) => setQuery({ preset: event.currentTarget.value as ReportPreset })}
          >
            {REPORT_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {REPORT_PRESET_LABELS[preset]}
              </option>
            ))}
          </Select>
        </div>

        {query.preset === 'custom' ? (
          <>
            <div>
              <Label htmlFor="from">From</Label>
              <Input
                id="from"
                type="date"
                value={query.from ?? ''}
                onChange={(event) => setQuery({ from: event.currentTarget.value })}
              />
            </div>
            <div>
              <Label htmlFor="to">To</Label>
              <Input
                id="to"
                type="date"
                value={query.to ?? ''}
                onChange={(event) => setQuery({ to: event.currentTarget.value })}
              />
            </div>
          </>
        ) : null}

        {isAdmin || (teams.data?.items.length ?? 0) > 1 ? (
          <div>
            <Label htmlFor="teamId">Team</Label>
            <Select
              id="teamId"
              value={query.teamId ?? ''}
              onChange={(event) => setQuery({ teamId: event.currentTarget.value || undefined })}
            >
              <option value="">{isAdmin ? 'All teams' : 'My teams'}</option>
              {teams.data?.items.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        <div>
          <Label htmlFor="projectId">Project</Label>
          <Select
            id="projectId"
            value={query.projectId ?? ''}
            onChange={(event) => setQuery({ projectId: event.currentTarget.value || undefined })}
          >
            <option value="">All projects</option>
            {projects.data?.items.map((project) => (
              <option key={project.id} value={project.id}>
                {project.key} — {project.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="assigneeId">Member</Label>
          <Select
            id="assigneeId"
            value={query.assigneeId ?? ''}
            onChange={(event) => setQuery({ assigneeId: event.currentTarget.value || undefined })}
          >
            <option value="">Everyone</option>
            {people.data?.items.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="labelId">Label</Label>
          <Select
            id="labelId"
            value={query.labelId ?? ''}
            onChange={(event) => setQuery({ labelId: event.currentTarget.value || undefined })}
          >
            <option value="">All labels</option>
            {labels.data?.items.map((label: { id: string; name: string }) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {report.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      ) : needsDates ? (
        <EmptyState
          title="Choose both dates"
          description="A custom range needs a start and an end. Pick them above."
        />
      ) : report.isError || !report.data ? (
        <EmptyState
          title="The report could not be built"
          description="Try a narrower range, or reload the page."
        />
      ) : (
        <ReportSections data={report.data} />
      )}
    </div>
  );
}

/**
 * The seven sections.
 *
 * It takes only the response: every drill-down link is built by the server
 * from the filters it actually answered with, so there is no second copy of
 * the query here to fall out of step with the numbers.
 *
 * Separate from the page because the filters and the header have to stay on
 * screen whatever the state of the request: an early return that replaced
 * the whole page left somebody who picked "Custom" looking at an error with
 * no date fields to fix it with, and no way back.
 */
function ReportSections({ data }: { data: Report }) {
  return (
    <div className="space-y-5">
      {/* ---------------------------------------------------- 1. summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <SummaryCard label="Created" metric={data.summary.created} />
        <SummaryCard label="Completed" metric={data.summary.completed} />
        <SummaryCard label="On-time rate" metric={data.summary.onTimeRate} suffix="%" />
        <SummaryCard
          label="Median cycle"
          metric={data.summary.medianCycleHours}
          suffix="h"
          hint="working hours from first started to completed"
        />
        <SummaryCard label="Overdue now" metric={data.summary.overdueNow} tone="danger" />
        <SummaryCard label="Blocked now" metric={data.summary.blockedNow} tone="warning" />
      </div>

      {/* ------------------------------------------------- 2. throughput */}
      <Card className="min-w-0">
        <CardHeader title="Throughput" subtitle="Completed per week, with created as a line" />
        {/*
          The weeks are generated from the range, so this list is never
          empty: with no activity it is a row of zeros, which draws a chart
          that looks like data. The question is whether anything happened.
        */}
        {data.throughput.every((week) => week.created === 0 && week.completed === 0) ? (
          <EmptyState
            title="Nothing in this range"
            description="No tasks were created or completed between these dates."
          />
        ) : (
          <AreaTrend
            data={data.throughput.map((week) => ({
              label: week.label,
              a: week.completed,
              b: week.created,
            }))}
            seriesA={{ key: 'a', label: 'Completed' }}
            seriesB={{ key: 'b', label: 'Created' }}
            height={260}
          />
        )}
      </Card>

      {/* ---------------------------------------------- 3. overdue trend */}
      <Card className="min-w-0">
        <CardHeader
          title="Overdue trend"
          subtitle="Open and past due, at the end of each day"
          action={
            data.overdueTrend.some((day) => day.estimated) ? (
              <span className="text-[11px] text-ink-faint">Some days are rebuilt from history</span>
            ) : null
          }
        />
        {data.overdueTrend.length === 0 || data.overdueTrend.every((day) => day.overdue === 0) ? (
          <EmptyState
            title="Nothing was overdue in this range"
            description="The nightly snapshot records this from the day it first runs; earlier days are rebuilt from the activity log where it allows."
          />
        ) : (
          <SimpleLine
            data={data.overdueTrend.map((day) => ({
              label: formatDate(day.date),
              value: day.overdue,
            }))}
            height={220}
          />
        )}
      </Card>

      {/* ------------------------------------------------ 4. cycle time */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader
            title="Cycle time by week"
            subtitle="Median and 75th percentile, working hours"
          />
          <CycleChart points={data.cycleByWeek} />
        </Card>

        <Card className="min-w-0">
          <CardHeader title="Cycle time by priority" />
          <CycleChart points={data.cycleByPriority} />
        </Card>

        <Card className="min-w-0 lg:col-span-2">
          <CardHeader title="Cycle time by label" />
          <CycleChart points={data.cycleByLabel} />
        </Card>
      </div>

      {/* ----------------------------------------------- 5. blocked time */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader title="Blocked time" subtitle="Working hours waiting, by what it waited on" />
          {data.blockedByType.length === 0 ? (
            <EmptyState
              title="Nothing was blocked"
              description="No task was blocked in this range."
            />
          ) : (
            <BarList
              data={data.blockedByType.map((row) => ({
                label: row.label,
                value: row.hours,
              }))}
            />
          )}
        </Card>

        <Card className="min-w-0 p-0">
          <div className="p-4">
            <h2 className="text-sm font-semibold">Longest blocked</h2>
            <p className="mt-0.5 text-xs text-ink-muted">Top 10, by working hours waiting</p>
          </div>
          {data.longestBlocked.length === 0 ? (
            <div className="px-4 pb-4">
              <EmptyState
                title="Nothing was blocked"
                description="No task was blocked in this range."
              />
            </div>
          ) : (
            <DataTable columns={BLOCKED_COLUMNS} minWidth="34rem">
              <tbody className="divide-y divide-border-subtle">
                {data.longestBlocked.map((task) => (
                  <tr key={task.taskId} className="hover:bg-surface-muted">
                    <td className="px-3 py-2.5">
                      <Link
                        to={'/tasks/' + task.key}
                        className="font-mono text-xs text-accent hover:underline"
                      >
                        {task.key}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      <Truncated text={task.title} className="text-sm" />
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink-muted">
                      {task.blockerType ? BLOCKER_TYPE_LABELS[task.blockerType] : '—'}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-sm">{task.hours}h</td>
                    <td className="px-3 py-2.5 text-xs">
                      {task.current ? (
                        <span className="text-danger">still blocked</span>
                      ) : (
                        <span className="text-ink-faint">resolved</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>
      </div>

      {/* --------------------------------------------------- 6. people */}
      <Card className="min-w-0 p-0">
        <div className="p-4">
          <h2 className="text-sm font-semibold">People</h2>
          <p className="mt-0.5 text-xs text-ink-muted">
            Sorted by name. These are counts over the range, not a ranking.
          </p>
        </div>
        {data.people.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState
              title="Nobody has work in this range"
              description="No task in these filters is assigned to anyone."
            />
          </div>
        ) : (
          <DataTable columns={PEOPLE_COLUMNS} minWidth="44rem">
            <tbody className="divide-y divide-border-subtle">
              {data.people.map((person) => (
                <tr key={person.user.id} className="hover:bg-surface-muted">
                  <td className="px-3 py-2.5">
                    <Link to={'/team/' + person.user.id} className="hover:underline">
                      <UserAvatar user={person.user} size="sm" showName />
                    </Link>
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-sm">{person.completed}</td>
                  <td className="tabular px-3 py-2.5 text-right text-sm">
                    {person.onTimeRate === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      person.onTimeRate + '%'
                    )}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-sm">
                    {person.medianCycleHours === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      person.medianCycleHours + 'h'
                    )}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-sm">{person.openNow}</td>
                  <td className="tabular px-3 py-2.5 text-right text-sm">
                    {person.overdueNow > 0 ? (
                      <Link
                        to={'/tasks?overdue=true&assigneeId=' + person.user.id}
                        className="text-danger hover:underline"
                      >
                        {person.overdueNow}
                      </Link>
                    ) : (
                      person.overdueNow
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      {/* ------------------------------------------------- 7. projects */}
      <Card className="min-w-0 p-0">
        <div className="p-4">
          <h2 className="text-sm font-semibold">Projects</h2>
        </div>
        {data.projects.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState title="No projects match" description="Try widening the filters." />
          </div>
        ) : (
          <DataTable columns={PROJECT_COLUMNS} minWidth="44rem">
            <tbody className="divide-y divide-border-subtle">
              {data.projects.map((project) => (
                <tr key={project.projectId} className="hover:bg-surface-muted">
                  <td className="px-3 py-2.5">
                    <Link
                      to={'/tasks?projectId=' + project.projectId}
                      className="font-mono text-xs text-accent hover:underline"
                    >
                      {project.key}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <Truncated text={project.name} className="text-sm" />
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-sm">{project.openNow}</td>
                  <td className="tabular px-3 py-2.5 text-right text-sm">{project.completed}</td>
                  <td className="tabular px-3 py-2.5 text-right text-sm">{project.overdueNow}</td>
                  <td className="tabular px-3 py-2.5 text-right text-sm">
                    {project.onTimeRate === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      project.onTimeRate + '%'
                    )}
                  </td>
                  <td className="tabular px-3 py-2.5 text-right text-sm">{project.percentDone}%</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

const BLOCKED_COLUMNS: Column[] = [
  { label: 'Task', width: '7rem' },
  { label: 'Title', width: 'auto' },
  { label: 'Waiting on', width: '9rem' },
  { label: 'Hours', width: '6rem', align: 'right' },
  { label: 'State', width: '7rem' },
];

const PEOPLE_COLUMNS: Column[] = [
  { label: 'Person', width: 'auto' },
  { label: 'Completed', width: '7rem', align: 'right' },
  { label: 'On time', width: '6rem', align: 'right' },
  { label: 'Median cycle', width: '8rem', align: 'right' },
  { label: 'Open now', width: '6rem', align: 'right' },
  { label: 'Overdue now', width: '7rem', align: 'right' },
];

const PROJECT_COLUMNS: Column[] = [
  { label: 'Key', width: '6rem' },
  { label: 'Name', width: 'auto' },
  { label: 'Open', width: '5rem', align: 'right' },
  { label: 'Completed', width: '7rem', align: 'right' },
  { label: 'Overdue', width: '6rem', align: 'right' },
  { label: 'On time', width: '6rem', align: 'right' },
  { label: 'Done', width: '5rem', align: 'right' },
];

/**
 * One number, its comparison, and the rows behind it.
 *
 * The arrow is deliberately plain: it says the direction and nothing about
 * whether the direction is good. More tasks created is not better or worse
 * on its own, and a page that decided would be wrong half the time.
 */
function SummaryCard({
  label,
  metric,
  suffix = '',
  tone,
  hint,
}: {
  label: string;
  metric: ReportMetric | null;
  suffix?: string;
  tone?: 'danger' | 'warning';
  hint?: string;
}) {
  if (!metric) {
    return (
      <Card className="min-w-0">
        <FigureLabel>{label}</FigureLabel>
        <p
          className="mt-1 text-sm text-ink-faint"
          title="Nothing in this range had what the metric needs"
        >
          Not enough data
        </p>
      </Card>
    );
  }

  const delta = metric.previous === null ? null : metric.value - metric.previous;
  const body = (
    <>
      <FigureLabel>{label}</FigureLabel>
      <div className="mt-1 flex items-baseline gap-1.5">
        <Figure
          value={metric.value}
          size="md"
          className={cn(
            tone === 'danger' && metric.value > 0 && 'text-danger',
            tone === 'warning' && metric.value > 0 && 'text-warning',
          )}
        />
        {suffix ? <span className="text-xs text-ink-muted">{suffix}</span> : null}
      </div>

      {delta === null ? (
        <p className="mt-1 text-[11px] text-ink-faint">no earlier period to compare</p>
      ) : (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-muted" title={COMPARE_HINT}>
          {delta === 0 ? null : delta > 0 ? (
            <TrendingUp size={11} aria-hidden />
          ) : (
            <TrendingDown size={11} aria-hidden />
          )}
          {delta === 0
            ? 'unchanged'
            : (delta > 0 ? '+' : '') + Math.round(delta * 10) / 10 + suffix}
        </p>
      )}

      {hint ? <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p> : null}
    </>
  );

  if (!metric.drilldown) {
    return <Card className="min-w-0">{body}</Card>;
  }

  return (
    <Card className="min-w-0" interactive>
      <Link to={'/tasks?' + metric.drilldown} className="block" title="Open the tasks behind this">
        {body}
      </Link>
    </Card>
  );
}

/** Median against the 75th percentile: the typical case and the tail. */
function CycleChart({ points }: { points: CycleTimePoint[] }) {
  const usable = points.filter((point) => point.medianHours !== null);

  if (usable.length === 0) {
    return (
      <EmptyState
        title="No completed work in this range"
        description="Cycle time is measured from the first time a task was started to the moment it was completed, so it needs completions."
      />
    );
  }

  /*
   * The bar is the median; the 75th percentile rides in the tooltip rather
   * than as a second bar. Two bars per week in a chart this size read as
   * two unrelated series, and the question the page is answering is "how
   * long does this usually take, and how bad is the tail".
   */
  return (
    <GradientBars
      data={usable.map((point) => ({
        label: point.label,
        value: point.medianHours ?? 0,
        hint:
          'median ' +
          point.medianHours +
          'h · 75th percentile ' +
          (point.p75Hours ?? '—') +
          'h · ' +
          point.completed +
          ' completed',
      }))}
      valueFormat={(value) => value + 'h'}
      height={240}
    />
  );
}

/** Kept for the status chip in the blocked table, where a pill reads better. */
export { StatusBadge, DueBadge };
