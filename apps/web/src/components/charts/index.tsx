import { useId, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  LabelList,
  Line,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AXIS,
  AccentGradient,
  CHART_COLOURS,
  ChartFrame,
  ChartTooltip,
  GRID_STROKE,
  HatchPattern,
  LegendRow,
  useReducedMotion,
} from './chartBase';
import { cn } from '@/lib/utils';

/**
 * The chart kit.
 *
 * Nine shapes, all themed from tokens and all with the same three states. They
 * take plain arrays rather than anything domain-specific, so the dashboard can
 * decide what a bar means and this file never has to know.
 */

/** The palette, cycled. Written as a function so the index is always defined. */
export function colourAt(index: number): string {
  return CHART_COLOURS[index % CHART_COLOURS.length] as string;
}

export interface Datum {
  label: string;
  value: number;
  /** Where clicking this segment should go, if anywhere. */
  href?: string;
  colour?: string;
}

// ---------------------------------------------------------------------------
// 1. Gradient bars, with a highlighted range and value labels
// ---------------------------------------------------------------------------

export function GradientBars({
  data,
  highlightFrom,
  loading,
  height = 200,
  valueFormat = (value: number) => String(value),
  onSelect,
  partialLast,
}: {
  data: Datum[];
  /** Index from which bars are "current" and take the accent gradient. */
  highlightFrom?: number;
  loading?: boolean;
  height?: number;
  valueFormat?: (value: number) => string;
  onSelect?: (datum: Datum) => void;
  /** The last bar is a week still running, so it is drawn as incomplete. */
  partialLast?: boolean;
}) {
  const gradientId = useId();
  const hatchId = useId();
  const reduced = useReducedMotion();
  const from = highlightFrom ?? data.length;

  // Recharts labels a data key, so the visible text is decided here rather
  // than in a formatter that has to guess its own row index.
  const plotted = data.map((datum, index) => ({
    ...datum,
    highlightLabel: index >= from ? valueFormat(datum.value) : '',
  }));

  return (
    <ChartFrame loading={loading} empty={data.length === 0} height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={plotted} margin={{ top: 18, right: 4, left: -22, bottom: 0 }}>
          <defs>
            <AccentGradient id={gradientId} />
            <HatchPattern id={hatchId} colour="var(--color-accent)" />
          </defs>
          <XAxis dataKey="label" {...AXIS} interval={0} minTickGap={2} />
          <YAxis {...AXIS} width={44} />
          <Tooltip
            cursor={{ fill: GRID_STROKE }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const last = partialLast && String(label) === data[data.length - 1]?.label;
              return (
                <ChartTooltip
                  title={String(label) + (last ? ' — so far' : '')}
                  rows={[{ label: 'Value', value: valueFormat(Number(payload[0]?.value ?? 0)) }]}
                />
              );
            }}
          />
          <Bar
            dataKey="value"
            radius={[6, 6, 4, 4]}
            isAnimationActive={!reduced}
            onClick={(entry: unknown) => onSelect?.(entry as Datum)}
            cursor={onSelect ? 'pointer' : undefined}
          >
            {data.map((datum, index) => (
              <Cell
                key={datum.label}
                // The week still running is hatched, not solid: it is a count
                // in progress, not a week that came out low.
                fill={
                  partialLast && index === data.length - 1
                    ? 'url(#' + hatchId + ')'
                    : index >= from
                      ? 'url(#' + gradientId + ')'
                      : 'var(--color-chart-muted)'
                }
                stroke={
                  partialLast && index === data.length - 1 ? 'var(--color-accent)' : undefined
                }
                strokeWidth={partialLast && index === data.length - 1 ? 1 : 0}
              />
            ))}
            {/* Only the highlighted range is labelled; labelling all twelve is noise. */}
            {/* Only the highlighted range carries a number; twelve labels is noise. */}
            <LabelList
              dataKey="highlightLabel"
              position="top"
              className="tabular"
              fontSize={10}
              fill="var(--color-ink-muted)"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// 2. Donut with a centre total and a legend
// ---------------------------------------------------------------------------

export function Donut({
  data,
  centreLabel,
  centreValue,
  loading,
  size = 168,
  onSelect,
}: {
  data: Datum[];
  centreLabel?: string;
  centreValue: number | string;
  loading?: boolean;
  size?: number;
  onSelect?: (datum: Datum) => void;
}) {
  const total = data.reduce((sum, datum) => sum + datum.value, 0);
  const reduced = useReducedMotion();

  const radius = size / 2;
  const thickness = Math.max(14, size * 0.13);
  const inner = radius - thickness;
  const circumference = 2 * Math.PI * (inner + thickness / 2);

  /*
   * The start angle of each arc, worked out before the render rather than by
   * mutating a counter while mapping: a variable that is still changing after
   * render can disagree with itself on the next one.
   */
  const offsets: number[] = [];
  data.reduce((running, datum) => {
    offsets.push(running);
    return running + (datum.value / total) * circumference;
  }, 0);

  return (
    <ChartFrame loading={loading} empty={total === 0} height={size} className="flex justify-center">
      <div className="relative" style={{ width: size, height: size }}>
        {/*
          Drawn by hand rather than with Recharts' Pie: an SVG ring takes the
          keyboard and screen-reader treatment far more easily, and the centre
          label is simply a div rather than a positioned label component.
        */}
        <svg width={size} height={size} role="img" aria-label={describe(data, total)}>
          <g transform={'rotate(-90 ' + radius + ' ' + radius + ')'}>
            {data.map((datum, index) => {
              const dash = (datum.value / total) * circumference;
              return (
                <circle
                  key={datum.label}
                  cx={radius}
                  cy={radius}
                  r={inner + thickness / 2}
                  fill="none"
                  stroke={datum.colour ?? colourAt(index)}
                  strokeWidth={thickness}
                  strokeDasharray={dash + ' ' + (circumference - dash)}
                  strokeDashoffset={-(offsets[index] ?? 0)}
                  className={cn(
                    onSelect && 'cursor-pointer',
                    !reduced && 'transition-[stroke-dashoffset,stroke-dasharray] duration-500',
                  )}
                  onClick={onSelect ? () => onSelect(datum) : undefined}
                />
              );
            })}
          </g>
        </svg>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="tabular text-[28px] leading-none font-bold">{centreValue}</span>
          {centreLabel ? (
            <span className="mt-1 text-[11px] text-ink-muted">{centreLabel}</span>
          ) : null}
        </div>
      </div>
    </ChartFrame>
  );
}

function describe(data: Datum[], total: number): string {
  return data.map((d) => d.label + ' ' + Math.round((d.value / total) * 100) + '%').join(', ');
}

export function DonutLegend({
  data,
  onSelect,
}: {
  data: Datum[];
  onSelect?: (datum: Datum) => void;
}) {
  const total = data.reduce((sum, datum) => sum + datum.value, 0) || 1;
  return (
    <div className="space-y-0.5">
      {data.map((datum, index) => (
        <LegendRow
          key={datum.label}
          colour={datum.colour ?? colourAt(index)}
          label={datum.label}
          percent={Math.round((datum.value / total) * 100)}
          value={datum.value}
          {...(onSelect ? { onClick: () => onSelect(datum) } : {})}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Radar
// ---------------------------------------------------------------------------

/**
 * Fewer than five points is not a radar.
 *
 * A three or four sided polygon says nothing a bar list does not say more
 * plainly, and a four-point one is just a diamond whatever the numbers are.
 */
export function RadarShape({
  data,
  loading,
  height = 200,
}: {
  data: Datum[];
  loading?: boolean;
  height?: number;
}) {
  const reduced = useReducedMotion();

  if (!loading && data.length > 0 && data.length < 5) {
    return <BarList data={data} height={height} />;
  }

  return (
    <ChartFrame
      loading={loading}
      empty={data.every((datum) => datum.value === 0)}
      height={height}
      emptyTitle="No labelled work yet"
    >
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="72%">
          <PolarGrid stroke={GRID_STROKE} />
          <PolarAngleAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: 'var(--color-chart-axis)' }}
          />
          <PolarRadiusAxis tick={false} axisLine={false} />
          <Tooltip
            content={({ active, payload }) =>
              active && payload?.length ? (
                <ChartTooltip
                  title={String(payload[0]?.payload?.label ?? '')}
                  rows={[{ label: 'Tasks', value: Number(payload[0]?.value ?? 0) }]}
                />
              ) : null
            }
          />
          <Radar
            dataKey="value"
            stroke="var(--color-accent)"
            strokeWidth={2}
            fill="var(--color-accent)"
            fillOpacity={0.3}
            isAnimationActive={!reduced}
            dot={{ r: 2.5, fill: 'var(--color-accent)', strokeWidth: 0 }}
          />
        </RadarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** The horizontal fallback: label, bar, count. */
export function BarList({ data, height }: { data: Datum[]; height?: number }) {
  const highest = Math.max(1, ...data.map((datum) => datum.value));

  return (
    <div className="space-y-2.5 py-2" style={height ? { minHeight: height } : undefined}>
      {data.map((datum, index) => (
        <div key={datum.label} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 truncate text-ink-muted" title={datum.label}>
            {datum.label}
          </span>
          <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted">
            <span
              className="block h-full rounded-full"
              style={{
                width: Math.round((datum.value / highest) * 100) + '%',
                background: datum.colour ?? colourAt(index),
              }}
            />
          </span>
          <span className="tabular w-6 shrink-0 text-right font-medium">{datum.value}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Two-series smooth area, with toggles and marker dots
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  label: string;
  a: number;
  b: number;
}

export function AreaTrend({
  data,
  seriesA,
  seriesB,
  loading,
  height = 230,
  partialLast,
}: {
  data: SeriesPoint[];
  seriesA: { key: string; label: string };
  seriesB: { key: string; label: string };
  loading?: boolean;
  height?: number;
  /** The last point is a week still running, so it is drawn as incomplete. */
  partialLast?: boolean;
}) {
  const reduced = useReducedMotion();
  const idA = useId();
  const idB = useId();

  const [showA, setShowA] = useState(true);
  const [showB, setShowB] = useState(true);

  /*
   * The dashed tail is a second series holding only the final two points, so
   * the solid line can stop short of the week that has not finished.
   */
  const plotted = data.map((point, index) => {
    const tail = partialLast && index >= data.length - 2;
    return {
      ...point,
      a: partialLast && index === data.length - 1 ? null : point.a,
      b: partialLast && index === data.length - 1 ? null : point.b,
      aTail: tail ? point.a : null,
      bTail: tail ? point.b : null,
    };
  });

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <Toggle
          label={seriesA.label}
          colour="var(--color-chart-1)"
          on={showA}
          onChange={setShowA}
        />
        <Toggle
          label={seriesB.label}
          colour="var(--color-chart-4)"
          on={showB}
          onChange={setShowB}
        />
      </div>

      <ChartFrame loading={loading} empty={data.length === 0} height={height}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={plotted} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
            <defs>
              <linearGradient id={idA} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
                <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id={idB} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-chart-4)" stopOpacity={0.3} />
                <stop offset="100%" stopColor="var(--color-chart-4)" stopOpacity={0} />
              </linearGradient>
            </defs>

            <XAxis dataKey="label" {...AXIS} />
            <YAxis {...AXIS} width={44} />
            <Tooltip
              cursor={{ stroke: GRID_STROKE }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const last = partialLast && String(label) === data[data.length - 1]?.label;
                return (
                  <ChartTooltip
                    title={String(label) + (last ? ' — so far' : '')}
                    rows={payload.map((entry) => ({
                      label: entry.dataKey === 'a' ? seriesA.label : seriesB.label,
                      value: Number(entry.value ?? 0),
                      colour:
                        entry.dataKey === 'a' ? 'var(--color-chart-1)' : 'var(--color-chart-4)',
                    }))}
                  />
                );
              }}
            />

            {showA ? (
              <Area
                type="monotone"
                dataKey="a"
                stroke="var(--color-chart-1)"
                strokeWidth={2}
                fill={'url(#' + idA + ')'}
                isAnimationActive={!reduced}
                dot={{ r: 3, fill: 'var(--color-chart-1)', strokeWidth: 0 }}
                activeDot={{ r: 5 }}
              />
            ) : null}
            {showB ? (
              <Area
                type="monotone"
                dataKey="b"
                stroke="var(--color-chart-4)"
                strokeWidth={2}
                fill={'url(#' + idB + ')'}
                isAnimationActive={!reduced}
                dot={{ r: 3, fill: 'var(--color-chart-4)', strokeWidth: 0 }}
                activeDot={{ r: 5 }}
              />
            ) : null}
            {/*
              The run into the last point is redrawn dashed: that week is still
              going, and a solid line makes a partial count look like a drop.
            */}
            {partialLast && data.length >= 2 ? (
              <>
                {showA ? (
                  <Line
                    type="monotone"
                    dataKey="aTail"
                    stroke="var(--color-chart-1)"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ) : null}
                {showB ? (
                  <Line
                    type="monotone"
                    dataKey="bTail"
                    stroke="var(--color-chart-4)"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ) : null}
              </>
            ) : null}
          </AreaChart>
        </ResponsiveContainer>
      </ChartFrame>
    </div>
  );
}

function Toggle({
  label,
  colour,
  on,
  onChange,
}: {
  label: string;
  colour: string;
  on: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="inline-flex items-center gap-2 text-xs text-ink-muted"
    >
      <span
        className={cn(
          'relative h-4 w-7 rounded-full transition-colors',
          on ? '' : 'bg-surface-muted',
        )}
        style={on ? { background: colour } : undefined}
      >
        <span
          className={cn(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all',
            on ? 'left-3.5' : 'left-0.5',
          )}
        />
      </span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 5. Hatched bars, for "remaining" or "planned"
// ---------------------------------------------------------------------------

export function HatchedBars({
  data,
  loading,
  height = 180,
  valueFormat = (value: number) => String(value),
}: {
  data: Array<Datum & { planned?: boolean }>;
  loading?: boolean;
  height?: number;
  valueFormat?: (value: number) => string;
}) {
  const hatchId = useId();
  const gradientId = useId();
  const reduced = useReducedMotion();

  const plotted = data.map((datum) => ({ ...datum, valueLabel: valueFormat(datum.value) }));

  return (
    <ChartFrame loading={loading} empty={data.length === 0} height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={plotted} margin={{ top: 18, right: 4, left: -22, bottom: 0 }}>
          <defs>
            <AccentGradient id={gradientId} />
            <HatchPattern id={hatchId} colour="var(--color-chart-3)" />
          </defs>
          <XAxis dataKey="label" {...AXIS} />
          <YAxis {...AXIS} width={44} />
          <Tooltip
            cursor={{ fill: GRID_STROKE }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <ChartTooltip
                  title={String(label)}
                  rows={[
                    {
                      label: payload[0]?.payload?.planned ? 'Planned' : 'Actual',
                      value: valueFormat(Number(payload[0]?.value ?? 0)),
                    },
                  ]}
                />
              ) : null
            }
          />
          <Bar dataKey="value" radius={[6, 6, 4, 4]} isAnimationActive={!reduced}>
            {data.map((datum) => (
              <Cell
                key={datum.label}
                fill={datum.planned ? 'url(#' + hatchId + ')' : 'url(#' + gradientId + ')'}
                stroke={datum.planned ? 'var(--color-chart-3)' : undefined}
                strokeWidth={datum.planned ? 1 : 0}
              />
            ))}
            <LabelList
              dataKey="valueLabel"
              position="top"
              className="tabular"
              fontSize={10}
              fill="var(--color-ink-muted)"
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ---------------------------------------------------------------------------
// 6. Thin progress bar
// ---------------------------------------------------------------------------

export function ThinProgress({
  value,
  max = 100,
  label = 'Progress',
  className,
}: {
  value: number;
  max?: number;
  /** Always set: an unnamed progressbar is announced as a number with no subject. */
  label?: string;
  className?: string;
}) {
  const percent = max === 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={Math.round(percent) + '%'}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-muted', className)}
    >
      <div
        className="accent-gradient h-full rounded-full transition-[width] duration-300"
        style={{ width: percent + '%' }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 7. Segmented bar — the small blocks from the second reference
// ---------------------------------------------------------------------------

export function SegmentedBar({
  filled,
  total,
  blocks = 20,
  tone = 'var(--color-accent)',
  label,
  className,
}: {
  filled: number;
  total: number;
  blocks?: number;
  tone?: string;
  label?: string;
  className?: string;
}) {
  const fraction = total === 0 ? 0 : Math.max(0, Math.min(1, filled / total));
  const lit = Math.round(fraction * blocks);

  return (
    <span
      className={cn('inline-flex items-center gap-[2px]', className)}
      role="img"
      aria-label={label ?? filled + ' of ' + total}
    >
      {Array.from({ length: blocks }, (_, index) => (
        <span
          key={index}
          className="h-3 w-[3px] rounded-[1px]"
          style={{
            background: index < lit ? tone : 'var(--color-surface-muted)',
            opacity: index < lit ? 1 : 0.8,
          }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 8. Gradient ring gauge
// ---------------------------------------------------------------------------

export function RingGauge({
  value,
  label,
  size = 96,
  thickness = 9,
  caption,
}: {
  /** 0 to 100. */
  value: number;
  /**
   * Omit it where a labelled control next to the ring already carries the
   * same number. Two things announcing "Progress, 40%" is not twice as
   * accessible; it is one ambiguous control.
   */
  label?: string;
  size?: number;
  thickness?: number;
  caption?: string;
}) {
  const gradientId = useId();
  const reduced = useReducedMotion();

  const clamped = Math.max(0, Math.min(100, value));
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (clamped / 100) * circumference;

  return (
    <div className="relative inline-flex flex-col items-center" style={{ width: size }}>
      <svg
        width={size}
        height={size}
        {...(label
          ? { role: 'img', 'aria-label': label + ': ' + Math.round(clamped) + '%' }
          : { 'aria-hidden': true })}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" />
            <stop offset="100%" stopColor="var(--color-accent-2)" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-surface-muted)"
          strokeWidth={thickness}
        />
        {/*
          Nothing is drawn at zero. A round cap on a zero-length arc renders as
          a dot, which reads as a little bit of progress where there is none.
        */}
        {clamped > 0 ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={'url(#' + gradientId + ')'}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={dash + ' ' + (circumference - dash)}
            transform={'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'}
            className={reduced ? undefined : 'transition-[stroke-dasharray] duration-700'}
          />
        ) : null}
      </svg>

      <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="tabular text-base leading-none font-bold">{Math.round(clamped)}%</span>
      </span>

      {caption ? <span className="mt-1.5 text-[11px] text-ink-muted">{caption}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 9. Heatmap grid
// ---------------------------------------------------------------------------

export interface HeatCell {
  value: number;
  /** Hatched, never shaded: a weekend or a holiday. */
  disabled?: boolean;
  /** A warning outline: too much for one day, or due when nobody is working. */
  over?: boolean;
  /** Replaces the generated explanation, for "due on a holiday" and the like. */
  note?: string;
  tooltip?: string[];
}

export function Heatmap({
  rows,
  columns,
  cells,
  loading,
  max,
  unit = '',
  rowHref,
}: {
  rows: Array<{ id: string; label: string }>;
  columns: Array<{ id: string; label: string; sublabel?: string; title?: string }>;
  /** cells[rowId][columnId] */
  cells: Record<string, Record<string, HeatCell>>;
  loading?: boolean;
  max?: number;
  unit?: string;
  rowHref?: (rowId: string) => string;
}) {
  const highest =
    max ??
    Math.max(
      1,
      ...rows.flatMap((row) => columns.map((column) => cells[row.id]?.[column.id]?.value ?? 0)),
    );

  if (loading) {
    return <div className="skeleton h-56 w-full rounded-[var(--radius-input)]" />;
  }

  return (
    <div className="relative overflow-x-auto">
      <table className="w-full border-separate border-spacing-[3px] text-xs">
        <caption className="sr-only">Hours due per person per day</caption>
        <thead>
          <tr>
            <th scope="col" className="w-32 text-left font-normal text-ink-faint">
              <span className="sr-only">Person</span>
            </th>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className="px-0.5 text-center font-normal"
                title={column.title ?? undefined}
              >
                <span className="block text-[11px] text-ink-muted">{column.label}</span>
                {column.sublabel ? (
                  <span className="block text-[11px] text-ink-faint">{column.sublabel}</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" className="max-w-32 truncate pr-2 text-left text-[11px] font-normal">
                {rowHref ? (
                  <a href={rowHref(row.id)} className="hover:text-accent hover:underline">
                    {row.label}
                  </a>
                ) : (
                  row.label
                )}
              </th>
              {columns.map((column) => {
                const cell = cells[row.id]?.[column.id] ?? { value: 0 };
                const intensity = cell.disabled ? 0 : Math.min(1, cell.value / highest);
                const title =
                  row.label +
                  ' — ' +
                  column.label +
                  ': ' +
                  cell.value +
                  unit +
                  (cell.note ? ' — ' + cell.note : cell.over ? ' (more than a working day)' : '') +
                  (cell.tooltip?.length ? '\n' + cell.tooltip.join('\n') : '');

                return (
                  <td key={column.id} className="p-0">
                    <div
                      title={title}
                      data-testid={'heat-' + row.id + '-' + column.id}
                      data-value={cell.value}
                      className={cn(
                        'flex h-8 min-w-8 items-center justify-center rounded-md text-[11px] font-medium',
                        // Hatched, so a day nobody works is obviously different
                        // from a working day with nothing due on it.
                        cell.disabled && 'text-ink-faint',
                        cell.over && 'ring-1 ring-warning',
                      )}
                      style={
                        cell.disabled
                          ? {
                              backgroundColor: 'var(--color-surface-muted)',
                              backgroundImage:
                                'repeating-linear-gradient(45deg, var(--color-border-strong) 0 1px, transparent 1px 5px)',
                            }
                          : {
                              /*
                               * One ramp, one text colour. Switching the text
                               * at a guessed intensity meant the cells near
                               * the switch were unreadable either way, so the
                               * ramp now stops at --color-heat-max, which is
                               * the darkest shade the ink still clears.
                               */
                              background:
                                intensity === 0
                                  ? 'var(--color-surface-muted)'
                                  : 'color-mix(in srgb, var(--color-heat-max) ' +
                                    Math.round(18 + intensity * 82) +
                                    '%, transparent)',
                              color: 'var(--color-ink)',
                            }
                      }
                    >
                      {/*
                        Hours show whatever the day. Work due on a Saturday is
                        exactly what somebody needs to see, and hiding it left
                        an outline drawn around nothing.
                      */}
                      {cell.value > 0 ? cell.value : ''}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline, for the hero card
// ---------------------------------------------------------------------------

export function Sparkline({
  data,
  markers = [],
  height = 56,
}: {
  data: number[];
  /** Indexes to mark with a dot, as in the reference's Balance card. */
  markers?: number[];
  height?: number;
}) {
  const gradientId = useId();
  const reduced = useReducedMotion();
  const points = data.map((value, index) => ({ label: String(index), value }));

  if (data.length === 0) return <div style={{ height }} />;

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--color-accent)"
            strokeWidth={2}
            fill={'url(#' + gradientId + ')'}
            isAnimationActive={!reduced}
            dot={(props: { cx?: number; cy?: number; index?: number }) =>
              markers.includes(props.index ?? -1) ? (
                <circle
                  key={props.index}
                  cx={props.cx}
                  cy={props.cy}
                  r={3.5}
                  fill="var(--color-accent)"
                  stroke="var(--color-hero-to)"
                  strokeWidth={2}
                />
              ) : (
                <g key={props.index} />
              )
            }
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Line, used by the design page to show the plain variant
// ---------------------------------------------------------------------------

export function SimpleLine({ data, height = 160 }: { data: Datum[]; height?: number }) {
  const reduced = useReducedMotion();
  return (
    <ChartFrame empty={data.length === 0} height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
          <XAxis dataKey="label" {...AXIS} />
          <YAxis {...AXIS} width={44} />
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--color-accent)"
            strokeWidth={2}
            isAnimationActive={!reduced}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
