import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AttentionItem, DashboardSummary, UserSummary } from '@tm/shared';
import { ATTENTION_REASON_LABELS } from '@tm/shared';
import { api, toQuery } from '@/lib/api';
import { Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { StatusBadge, UserAvatar } from '@/components/common/badges';
import { formatDate } from '@/lib/utils';

/**
 * The digest, on screen.
 *
 * Built from the same endpoint the email is rendered from, so opening the
 * notification shows exactly what was emailed rather than a second version of
 * the same idea that can drift away from it.
 */

interface DigestLine {
  key: string;
  title: string;
  detail: string;
}

interface LeadDigest {
  kind: 'lead';
  user: { id: string; name: string };
  date: string;
  summary: DashboardSummary;
  attention: AttentionItem[];
  completedYesterday: DigestLine[];
  onLeaveToday: UserSummary[];
}

interface MemberDigest {
  kind: 'member';
  user: { id: string; name: string };
  date: string;
  overdue: DigestLine[];
  dueToday: DigestLine[];
  awaitingMyReview: DigestLine[];
}

export type Digest = LeadDigest | MemberDigest;

function useDigest(date: string | undefined) {
  return useQuery({
    queryKey: ['digest', date],
    queryFn: ({ signal }) => api.get<Digest>('/org/digest-preview' + toQuery({ date }), signal),
    enabled: Boolean(date),
  });
}

export function DigestPage() {
  const { date } = useParams<{ date: string }>();
  const digest = useDigest(date);

  if (digest.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (digest.isError || !digest.data) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <Card>
          <EmptyState
            title="That summary is not available"
            description="It may be for a day before you joined, or for somebody else."
          />
        </Card>
      </div>
    );
  }

  const data = digest.data;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">
          {data.kind === 'lead' ? 'Team status' : 'Your day'}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">{formatDate(data.date)}</p>
      </header>

      <DigestContent digest={data} />
    </div>
  );
}

/**
 * The body of a digest, without the page around it.
 *
 * Shared with the admin email preview, so what an administrator checks before
 * a send is the very thing the recipient will open.
 */
export function DigestContent({ digest }: { digest: Digest }) {
  return digest.kind === 'lead' ? (
    <LeadContent digest={digest} />
  ) : (
    <MemberContent digest={digest} />
  );
}

const KPI_LABELS: Array<[keyof DashboardSummary, string]> = [
  ['active', 'Active'],
  ['dueToday', 'Due today'],
  ['overdue', 'Overdue'],
  ['blocked', 'Blocked'],
  ['waitingReview', 'Waiting review'],
  ['noUpdate', 'No update'],
  ['unassignedOpen', 'Unassigned'],
  ['completedThisWeek', 'Done this week'],
];

function LeadContent({ digest }: { digest: LeadDigest }) {
  return (
    <>
      <section aria-label="Counts" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {KPI_LABELS.map(([key, label]) => (
          <Card key={key} className="p-3">
            <p className="text-xs text-ink-muted">{label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums">{String(digest.summary[key])}</p>
          </Card>
        ))}
      </section>

      <Section title="Needs your attention" empty="Nothing needs chasing.">
        {digest.attention.length > 0 ? (
          <ul className="divide-y divide-border-subtle">
            {digest.attention.map((item) => (
              <li
                key={item.taskId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
              >
                <Link
                  to={'/tasks/' + item.key}
                  className="font-mono text-xs text-accent hover:underline"
                >
                  {item.key}
                </Link>
                <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                <StatusBadge status={item.status} />
                <span className="text-xs text-ink-muted">
                  {ATTENTION_REASON_LABELS[item.reason]} · {item.detail}
                </span>
                <UserAvatar user={item.assignee} size="sm" />
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Completed yesterday" empty="Nothing was finished yesterday.">
        {digest.completedYesterday.length > 0 ? (
          <TaskLines lines={digest.completedYesterday} />
        ) : null}
      </Section>

      <Section title="On leave today" empty="Everybody is working today.">
        {digest.onLeaveToday.length > 0 ? (
          <ul className="flex flex-wrap gap-3 px-4 py-3">
            {digest.onLeaveToday.map((person) => (
              <li key={person.id}>
                <UserAvatar user={person} showName size="sm" />
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
    </>
  );
}

function MemberContent({ digest }: { digest: MemberDigest }) {
  return (
    <>
      <Section title="Overdue" empty="Nothing of yours is overdue.">
        {digest.overdue.length > 0 ? <TaskLines lines={digest.overdue} /> : null}
      </Section>
      <Section title="Due today" empty="Nothing of yours is due today.">
        {digest.dueToday.length > 0 ? <TaskLines lines={digest.dueToday} /> : null}
      </Section>
      <Section title="Waiting on your review" empty="No reviews are waiting on you.">
        {digest.awaitingMyReview.length > 0 ? <TaskLines lines={digest.awaitingMyReview} /> : null}
      </Section>
    </>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={'digest-' + title.replace(/\s+/g, '-')}>
      <h2 id={'digest-' + title.replace(/\s+/g, '-')} className="mb-2 text-sm font-semibold">
        {title}
      </h2>
      <Card>{children ?? <EmptyState title={empty} />}</Card>
    </section>
  );
}

function TaskLines({ lines }: { lines: DigestLine[] }) {
  return (
    <ul className="divide-y divide-border-subtle">
      {lines.map((line) => (
        <li key={line.key} className="flex items-center gap-3 px-4 py-2.5">
          <Link to={'/tasks/' + line.key} className="font-mono text-xs text-accent hover:underline">
            {line.key}
          </Link>
          <span className="min-w-0 flex-1 truncate text-sm">{line.title}</span>
          <span className="text-xs text-ink-muted">{line.detail}</span>
        </li>
      ))}
    </ul>
  );
}
