import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useAdminPeople, useSendTestEmail } from './api';
import { AdminPage, Banner, Field, useBanner } from './shared';
import { DigestContent, type Digest } from '@/features/digest/DigestPage';
import { Button, Card, EmptyState, Input, Select, Skeleton } from '@/components/ui/primitives';
import { useAuth } from '@/features/auth/AuthContext';
import { api, toQuery } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { formatDate } from '@/lib/utils';

/**
 * Checking email before anyone depends on it.
 *
 * Two questions an administrator has on the first day: does mail leave the
 * building at all, and what will people actually receive? The test email
 * answers the first; the preview answers the second, for any person and any
 * day, without sending anything or marking the day as done.
 */

export function EmailPage() {
  const { user } = useAuth();
  const sendTest = useSendTestEmail();
  const banner = useBanner();

  const people = useAdminPeople({ active: true });

  const [userId, setUserId] = useState(user?.id ?? '');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  const preview = useQuery({
    queryKey: queryKeys.admin.digestPreview(userId, date),
    queryFn: ({ signal }) =>
      api.get<Digest>('/org/digest-preview' + toQuery({ userId, date }), signal),
    enabled: Boolean(userId && date),
  });

  return (
    <AdminPage
      title="Email"
      description="Prove that mail leaves the building, then look at exactly what will land in somebody's inbox."
    >
      <Banner {...banner.props} />

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Test email</h2>
        <p className="mt-1 mb-3 text-sm text-ink-muted">
          Sent to your own address and nowhere else. Check the headers show <code>spf=pass</code>{' '}
          and <code>dkim=pass</code> before inviting anybody.
        </p>
        <Button
          disabled={sendTest.isPending}
          onClick={async () => {
            try {
              const result = await sendTest.mutateAsync();
              banner.show('success', 'Sent to ' + result.to + '.');
            } catch (error) {
              banner.show(
                'error',
                error instanceof Error ? error.message : 'The message could not be sent.',
              );
            }
          }}
        >
          <Send size={15} aria-hidden /> Send a test email
        </Button>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">Digest preview</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Whose digest">
            <Select value={userId} onChange={(event) => setUserId(event.target.value)}>
              {people.data?.items.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Which day">
            <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
        </div>

        <p className="mt-2 text-xs text-ink-faint">
          Nothing is sent and nothing is recorded, so the real digest for that day still goes out.
        </p>
      </Card>

      {preview.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : preview.isError ? (
        <Card>
          <EmptyState
            title="That digest could not be built"
            description="The person may not have been here on that day."
          />
        </Card>
      ) : preview.data ? (
        <section aria-label="Digest preview" className="space-y-4">
          <header className="border-t border-border-subtle pt-4">
            <h2 className="text-base font-semibold">
              {preview.data.kind === 'lead' ? 'Team status' : 'Your day'} — {formatDate(date)}
            </h2>
            <p className="text-xs text-ink-faint">As {preview.data.user.name} would see it.</p>
          </header>

          <DigestContent digest={preview.data} />
        </section>
      ) : null}
    </AdminPage>
  );
}
