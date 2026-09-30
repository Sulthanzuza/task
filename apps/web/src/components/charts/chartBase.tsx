import { useEffect, useState, type ReactNode } from 'react';
import { EmptyState, Skeleton } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * The shared parts of the chart kit.
 *
 * Colours are referenced as CSS variables inside the SVG rather than read out
 * of the computed style, so switching theme repaints the charts immediately and
 * no chart has to be told which theme it is in.
 */

export const CHART_COLOURS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
  'var(--color-chart-6)',
  'var(--color-chart-7)',
  'var(--color-chart-8)',
] as const;

export const AXIS = {
  stroke: 'var(--color-chart-axis)',
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

export const GRID_STROKE = 'var(--color-chart-grid)';

/** Recharts animates by default; this is how the kit honours the OS setting. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

/**
 * Every chart gets the same three states.
 *
 * "No data yet" is a real answer and deserves to look deliberate rather than
 * like a chart that failed to draw.
 */
export function ChartFrame({
  loading,
  empty,
  emptyTitle = 'Nothing to chart yet',
  emptyDescription,
  height = 220,
  className,
  children,
}: {
  loading?: boolean;
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  height?: number;
  className?: string;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className={cn('w-full min-w-0', className)} style={{ height }}>
        <Skeleton className="h-full w-full" />
      </div>
    );
  }

  if (empty) {
    return (
      <div className={cn('flex items-center justify-center', className)} style={{ height }}>
        <EmptyState
          title={emptyTitle}
          {...(emptyDescription ? { description: emptyDescription } : {})}
        />
      </div>
    );
  }

  /*
   * min-w-0 matters here: Recharts' ResponsiveContainer measures its parent,
   * and a flex or grid item without it reports the content width rather than
   * the track width, so the chart grows the page instead of fitting it.
   */
  return (
    <div className={cn('w-full min-w-0', className)} style={{ height }}>
      {children}
    </div>
  );
}

/** The tooltip, styled from tokens rather than Recharts' inline defaults. */
export function ChartTooltip({
  title,
  rows,
}: {
  title?: ReactNode;
  rows: Array<{ label: ReactNode; value: ReactNode; colour?: string }>;
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface px-3 py-2 shadow-[var(--shadow-lift)]">
      {title ? <p className="mb-1 text-xs font-medium">{title}</p> : null}
      <ul className="space-y-0.5">
        {rows.map((row, index) => (
          <li key={index} className="flex items-center gap-2 text-xs">
            {row.colour ? (
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: row.colour }}
              />
            ) : null}
            <span className="text-ink-muted">{row.label}</span>
            <span className="tabular ml-auto font-medium">{row.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The gradient definitions a chart needs, declared once per chart instance.
 * The id must be unique on the page or two charts share one gradient.
 */
export function AccentGradient({ id, vertical = true }: { id: string; vertical?: boolean }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2={vertical ? '0' : '1'} y2={vertical ? '1' : '0'}>
      <stop offset="0%" stopColor="var(--color-accent)" />
      <stop offset="100%" stopColor="var(--color-accent-2)" />
    </linearGradient>
  );
}

/** Diagonal stripes, for "remaining" or "planned" quantities. */
export function HatchPattern({ id, colour }: { id: string; colour: string }) {
  return (
    <pattern
      id={id}
      width={6}
      height={6}
      patternTransform="rotate(45)"
      patternUnits="userSpaceOnUse"
    >
      <rect width={6} height={6} fill="transparent" />
      <line x1="0" y1="0" x2="0" y2="6" stroke={colour} strokeWidth={2.5} opacity={0.5} />
    </pattern>
  );
}

/** A legend row: swatch, label, then the figures right-aligned. */
export function LegendRow({
  colour,
  label,
  percent,
  value,
  onClick,
}: {
  colour: string;
  label: ReactNode;
  percent?: number;
  value?: ReactNode;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: colour }} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {percent !== undefined ? (
        <span className="tabular w-10 text-right text-ink-muted">{percent}%</span>
      ) : null}
      {value !== undefined ? (
        <span className="tabular w-12 text-right font-medium">{value}</span>
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-xs transition-colors hover:bg-surface-muted"
      >
        {content}
      </button>
    );
  }

  return <div className="flex w-full items-center gap-2 px-1.5 py-1 text-xs">{content}</div>;
}
