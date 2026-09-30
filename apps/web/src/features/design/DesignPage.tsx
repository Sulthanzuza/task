import { useState } from 'react';
import { TASK_PRIORITIES, TASK_STATUSES } from '@tm/shared';
import { THEME_META, THEMES, useTheme } from '@/app/theme';
import {
  AreaTrend,
  Donut,
  DonutLegend,
  GradientBars,
  HatchedBars,
  Heatmap,
  RadarShape,
  RingGauge,
  SegmentedBar,
  SimpleLine,
  Sparkline,
  ThinProgress,
  colourAt,
  type Datum,
} from '@/components/charts';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Figure,
  FigureLabel,
  HeroCard,
  Input,
  Label,
  Pill,
  SegmentedTabs,
  Select,
  Skeleton,
  Spinner,
  Textarea,
} from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  BlockerBadge,
  DueBadge,
  LabelChip,
  PriorityBadge,
  ProgressBar,
  StatusBadge,
  UserAvatar,
} from '@/components/common/badges';
import { Markdown } from '@/components/common/Markdown';

/**
 * Every token, component and chart in one place.
 *
 * Kept out of production builds by the router. It exists so a change to the
 * palette can be judged against all four themes at once, rather than by
 * clicking through the app hoping to find the thing that broke.
 */

const SURFACE_TOKENS = [
  'canvas',
  'canvas-tint',
  'surface',
  'surface-muted',
  'surface-raised',
  'border-subtle',
  'border-strong',
  'ink',
  'ink-muted',
  'ink-faint',
];

const ACCENT_TOKENS = [
  'accent',
  'accent-2',
  'accent-hover',
  'accent-soft',
  'secondary',
  'secondary-soft',
];

const FEEDBACK_TOKENS = [
  'danger',
  'danger-soft',
  'warning',
  'warning-soft',
  'success',
  'success-soft',
  'info',
  'info-soft',
  'neutral-soft',
];

const CHART_TOKENS = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
  'chart-8',
];

const BARS: Datum[] = [
  { label: 'W1', value: 4 },
  { label: 'W2', value: 7 },
  { label: 'W3', value: 5 },
  { label: 'W4', value: 9 },
  { label: 'W5', value: 6 },
  { label: 'W6', value: 11 },
  { label: 'W7', value: 8 },
  { label: 'W8', value: 12 },
];

const SLICES: Datum[] = [
  { label: 'In progress', value: 12 },
  { label: 'Assigned', value: 8 },
  { label: 'Blocked', value: 3 },
  { label: 'In review', value: 5 },
  { label: 'Backlog', value: 9 },
];

const RADAR: Datum[] = [
  { label: 'bug', value: 9 },
  { label: 'feature', value: 14 },
  { label: 'tech-debt', value: 5 },
  { label: 'docs', value: 3 },
  { label: 'infra', value: 7 },
];

const TREND = Array.from({ length: 8 }, (_, index) => ({
  label: 'W' + (index + 1),
  a: 4 + ((index * 3) % 7),
  b: 2 + ((index * 5) % 6),
}));

const HEAT_ROWS = [
  { id: 'rahul', label: 'Rahul' },
  { id: 'arun', label: 'Arun' },
  { id: 'faisal', label: 'Faisal' },
];

const HEAT_COLUMNS = Array.from({ length: 10 }, (_, index) => ({
  id: 'd' + index,
  label: String(index + 1),
  sublabel: index % 5 === 0 ? 'Mon' : undefined,
}));

const HEAT_CELLS: Record<string, Record<string, { value: number; disabled?: boolean }>> = {
  rahul: Object.fromEntries(
    HEAT_COLUMNS.map((column, index) => [
      column.id,
      { value: (index * 3) % 9, disabled: index === 5 },
    ]),
  ),
  arun: Object.fromEntries(
    HEAT_COLUMNS.map((column, index) => [
      column.id,
      { value: (index * 5) % 8, disabled: index === 5 },
    ]),
  ),
  faisal: Object.fromEntries(
    HEAT_COLUMNS.map((column, index) => [
      column.id,
      { value: (index * 2) % 6, disabled: index === 5 },
    ]),
  ),
};

export function DesignPage() {
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<'costs' | 'goals' | 'inflow'>('inflow');
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Design system</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Every token, component and chart. Switch theme to check all four.
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {THEMES.map((name) => (
            <Button
              key={name}
              size="sm"
              variant={theme === name ? 'primary' : 'outline'}
              onClick={() => setTheme(name)}
            >
              {THEME_META[name].label}
            </Button>
          ))}
        </div>
      </header>

      <Section title="Colour tokens" subtitle={'Current theme: ' + THEME_META[theme].label}>
        <div className="space-y-4">
          <Swatches title="Surfaces and ink" names={SURFACE_TOKENS} />
          <Swatches title="Accent" names={ACCENT_TOKENS} />
          <Swatches title="Feedback" names={FEEDBACK_TOKENS} />
          <Swatches title="Charts" names={CHART_TOKENS} />
        </div>
      </Section>

      <Section title="Typography">
        <div className="space-y-3">
          <div>
            <Figure value="1,284" />
            <FigureLabel className="ml-2">32px bold, tabular</FigureLabel>
          </div>
          <div>
            <Figure value="41%" size="md" />
            <FigureLabel className="ml-2">28px bold, tabular</FigureLabel>
          </div>
          <p className="text-sm">Body text, 14px. Plus Jakarta Sans throughout.</p>
          <p className="text-xs text-ink-muted">Label text, 12px muted.</p>
          <p className="tabular text-sm">0123456789 — tabular figures line up in columns.</p>
        </div>
      </Section>

      <Section title="Surfaces">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader title="Card" subtitle="rounded-3xl, 20px padding" />
            <p className="text-sm text-ink-muted">The default surface for everything.</p>
          </Card>

          <Card interactive>
            <CardHeader title="Interactive card" subtitle="hover to lift" />
            <p className="text-sm text-ink-muted">Only used where the whole card is a link.</p>
          </Card>

          <HeroCard>
            <FigureLabel className="text-[var(--color-hero-ink-muted)]">Hero card</FigureLabel>
            <div className="mt-1">
              <Figure value="2,102" className="text-[var(--color-hero-ink)]" />
            </div>
            <p className="mt-1 text-xs text-[var(--color-hero-ink-muted)]">
              Stays dark in every theme.
            </p>
            <Sparkline data={[3, 6, 4, 8, 7, 11, 9, 13]} markers={[2, 5, 7]} />
          </HeroCard>
        </div>
      </Section>

      <Section title="Controls">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <Button>
            <Spinner /> Working
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-4">
          <SegmentedTabs
            label="Example"
            value={tab}
            onChange={(next) => setTab(next)}
            options={[
              { value: 'costs', label: 'Costs' },
              { value: 'goals', label: 'Goals' },
              { value: 'inflow', label: 'Inflow' },
            ]}
          />
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Open a confirm dialog
          </Button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="d-input">Input</Label>
            <Input id="d-input" placeholder="rounded-xl" />
          </div>
          <div>
            <Label htmlFor="d-select">Select</Label>
            <Select id="d-select">
              <option>One</option>
              <option>Two</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="d-textarea">Textarea</Label>
            <Textarea id="d-textarea" rows={2} placeholder="Write something" />
          </div>
        </div>
      </Section>

      <Section title="Badges and chips" subtitle="Each carries text or an icon, never colour alone">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {TASK_STATUSES.map((status) => (
              <StatusBadge key={status} status={status} />
            ))}
          </div>
          <div className="flex flex-wrap gap-4">
            {TASK_PRIORITIES.map((priority) => (
              <PriorityBadge key={priority} priority={priority} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <DueBadge dueDate="2020-01-01" />
            <DueBadge dueDate={new Date().toISOString().slice(0, 10)} />
            <DueBadge dueDate="2099-01-01" />
            <BlockerBadge type="WAITING_ON_CLIENT" />
            <LabelChip name="bug" color="var(--color-chart-6)" />
            <LabelChip name="feature" color="var(--color-chart-3)" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill>Neutral</Pill>
            <Pill tone="accent">Accent</Pill>
            <Pill tone="success">Success</Pill>
            <Pill tone="warning">Warning</Pill>
            <Pill tone="danger">Danger</Pill>
            <Pill tone="info">Info</Pill>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <UserAvatar user={person('Rahul Menon')} showName />
            <UserAvatar user={person('Arun Das')} size="sm" showName />
            <UserAvatar user={null} />
          </div>
        </div>
      </Section>

      <Section title="States">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader title="Loading" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          </Card>
          <Card padded={false}>
            <EmptyState
              title="Nothing here yet"
              description="Empty states say what would appear and how to make it appear."
              action={<Button size="sm">Create one</Button>}
            />
          </Card>
          <Card>
            <CardHeader title="Progress" />
            <div className="space-y-3">
              <ProgressBar value={35} showLabel />
              <ThinProgress value={72} label="Example" />
              <SegmentedBar filled={7} total={10} label="7 of 10" />
              <SegmentedBar filled={3} total={10} tone="var(--color-danger)" label="3 of 10" />
            </div>
          </Card>
        </div>
      </Section>

      <Section title="Charts">
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader title="Gradient bars" subtitle="current range highlighted" />
            <GradientBars data={BARS} highlightFrom={5} />
          </Card>

          <Card>
            <CardHeader title="Donut" subtitle="centre total and legend" />
            <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
              <Donut data={SLICES} centreValue={37} centreLabel="Open" size={150} />
              <DonutLegend data={SLICES} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Radar" subtitle="work mix by label" />
            <RadarShape data={RADAR} />
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader title="Area trend" subtitle="two series with toggles" />
            <AreaTrend
              data={TREND}
              seriesA={{ key: 'a', label: 'Created' }}
              seriesB={{ key: 'b', label: 'Completed' }}
            />
          </Card>

          <Card>
            <CardHeader title="Hatched bars" subtitle="planned versus actual" />
            <HatchedBars
              data={[
                { label: '2028', value: 6 },
                { label: '2029', value: 10 },
                { label: '2030', value: 8, planned: true },
              ]}
            />
          </Card>

          <Card>
            <CardHeader title="Ring gauge" />
            <div className="flex items-center justify-around py-2">
              <RingGauge value={41} caption="On time" />
              <RingGauge value={88} caption="Done" size={72} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Simple line" />
            <SimpleLine data={BARS} />
          </Card>

          <Card>
            <CardHeader title="Empty and loading" />
            <GradientBars data={[]} />
            <GradientBars data={BARS} loading />
          </Card>

          <Card className="lg:col-span-3">
            <CardHeader title="Heatmap" subtitle="weekends and holidays greyed out" />
            <Heatmap rows={HEAT_ROWS} columns={HEAT_COLUMNS} cells={HEAT_CELLS} unit="h" />
          </Card>
        </div>
      </Section>

      <Section title="Markdown">
        <Markdown
          text={
            '## A heading\n\nBody text with **bold**, *italic*, `code` and a ' +
            '[link](https://example.com).\n\n- one\n- two\n\n> A quotation.'
          }
          className="text-sm"
        />
      </Section>

      <ConfirmDialog
        open={confirming}
        title="Delete this example?"
        description="Nothing will actually happen. This is the shared confirm dialog."
        confirmLabel="Delete"
        onCancel={() => setConfirming(false)}
        onConfirm={() => setConfirming(false)}
      />
    </div>
  );
}

function person(name: string) {
  return {
    id: name,
    name,
    email: name.toLowerCase().replace(/\s+/g, '.') + '@example.com',
    role: 'MEMBER' as const,
    avatarUrl: null,
    isActive: true,
  };
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={'design-' + title.replace(/\s+/g, '-')}>
      <h2
        id={'design-' + title.replace(/\s+/g, '-')}
        className="mb-3 text-sm font-semibold tracking-wide text-ink-muted uppercase"
      >
        {title}
      </h2>
      {subtitle ? <p className="mb-3 text-xs text-ink-faint">{subtitle}</p> : null}
      {children}
    </section>
  );
}

function Swatches({ title, names }: { title: string; names: string[] }) {
  return (
    <div>
      <p className="mb-2 text-xs text-ink-faint">{title}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        {names.map((name) => (
          <div
            key={name}
            className="overflow-hidden rounded-xl border border-border-subtle bg-surface"
          >
            <div
              className="h-12 w-full"
              style={{ background: 'var(--color-' + name + ')' }}
              aria-hidden
            />
            <p className="px-2 py-1.5 font-mono text-[10px] text-ink-muted">{name}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export { colourAt };
