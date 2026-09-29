import { NOTIFICATION_TYPES } from '@tm/shared';
import { Card, Skeleton } from '@/components/ui/primitives';
import { useNotificationPreferences, useSetPreference } from './api';

/** Readable names for the notification types, so the page is not a wall of enums. */
const LABELS: Record<string, string> = {
  TASK_ASSIGNED: 'A task is assigned to me',
  TASK_MENTIONED: 'Someone mentions me',
  TASK_STATUS_CHANGED: 'A task I follow changes status',
  TASK_REVIEW_REQUESTED: 'A task is ready for my review',
  TASK_CHANGES_REQUESTED: 'Changes are requested on my task',
  TASK_COMMENTED: 'Someone comments on a task I follow',
  TASK_DEPENDENCY_COMPLETED: 'Something my task was waiting on is done',
  ALERT_OVERDUE: 'A task of mine is overdue',
  ALERT_DUE_TOMORROW: 'A task of mine is due tomorrow',
  ALERT_NO_UPDATE: 'A task of mine has had no update',
  ALERT_BLOCKED: 'A task stays blocked',
  ALERT_REVIEW_WAITING: 'A review is waiting too long',
  ESCALATION: 'Something is escalated to me',
  DAILY_DIGEST: 'The daily digest',
  CHECKIN_REMINDER: 'A reminder to check in',
};

export function NotificationPreferencesPage() {
  const preferences = useNotificationPreferences();
  const setPreference = useSetPreference();

  const byType = new Map(preferences.data?.items.map((p) => [p.type, p]));

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Notification preferences</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Quiet hours are 20:00 to 08:00 in your own time zone. Anything sent during them waits
          until the morning.
        </p>
      </header>

      <Card className="overflow-hidden">
        {preferences.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs text-ink-muted">
                <th className="px-4 py-2 font-medium">Tell me when</th>
                <th className="w-20 px-2 py-2 text-center font-medium">In app</th>
                <th className="w-20 px-2 py-2 text-center font-medium">Email</th>
                <th className="w-28 px-2 py-2 text-center font-medium">
                  Digest only
                  <span className="block text-[11px] font-normal text-ink-faint">once a day</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_TYPES.map((type) => {
                const preference = byType.get(type) ?? {
                  type,
                  inApp: true,
                  email: true,
                  digestOnly: false,
                };
                return (
                  <tr key={type} className="border-b border-border-subtle last:border-0">
                    <td className="px-4 py-2.5">{LABELS[type] ?? type}</td>
                    <td className="px-2 py-2.5 text-center">
                      <input
                        type="checkbox"
                        aria-label={'In app: ' + (LABELS[type] ?? type)}
                        checked={preference.inApp}
                        className="accent-[var(--color-accent)]"
                        onChange={(e) =>
                          setPreference.mutate({ type, inApp: e.currentTarget.checked })
                        }
                      />
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <input
                        type="checkbox"
                        aria-label={'Email: ' + (LABELS[type] ?? type)}
                        checked={preference.email}
                        className="accent-[var(--color-accent)]"
                        onChange={(e) =>
                          setPreference.mutate({ type, email: e.currentTarget.checked })
                        }
                      />
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      {/*
                        Only meaningful when email is on: it moves this kind of
                        change out of its own message and into the daily digest.
                      */}
                      <input
                        type="checkbox"
                        aria-label={'Digest only: ' + (LABELS[type] ?? type)}
                        checked={preference.digestOnly}
                        disabled={!preference.email}
                        title={
                          preference.email
                            ? 'Collect these into the daily digest instead of emailing each one'
                            : 'Turn email on first'
                        }
                        className="accent-[var(--color-accent)] disabled:opacity-40"
                        onChange={(e) =>
                          setPreference.mutate({ type, digestOnly: e.currentTarget.checked })
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
