import { useState } from 'react';
import { WEEKDAY_NAMES, type OrgSettingsView, type UpdateOrgSettingsInput } from '@tm/shared';
import { useOrgSettings, useUpdateOrgSettings } from './api';
import { AdminPage, Banner, Field, useBanner } from './shared';
import { Button, Card, Input, Select, Skeleton } from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';

/**
 * The facts every date calculation in the system depends on.
 *
 * Changing the time zone or the digest hour moves the scheduled jobs, so the
 * save confirms that the alerts were rescheduled rather than leaving the admin
 * to wonder whether tomorrow's digest will arrive at the old time.
 */

/** A short list beats a thousand-entry dropdown nobody can scroll. */
const COMMON_TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'UTC',
];

export function OrganisationPage() {
  const settings = useOrgSettings();

  if (settings.isLoading || !settings.data) {
    return (
      <AdminPage title="Organisation">
        <Skeleton className="h-96 w-full" />
      </AdminPage>
    );
  }

  // The form owns its own state from the moment it exists, so there is no
  // effect syncing two copies of the same thing while somebody is typing.
  return <SettingsForm saved={settings.data} />;
}

function SettingsForm({ saved }: { saved: OrgSettingsView }) {
  const save = useUpdateOrgSettings();
  const banner = useBanner();

  const [form, setForm] = useState<UpdateOrgSettingsInput>(() => ({
    timezone: saved.timezone,
    weekendDays: saved.weekendDays,
    weekStartsOn: saved.weekStartsOn,
    workHoursPerDay: saved.workHoursPerDay,
    noUpdateThresholdHours: saved.noUpdateThresholdHours,
    blockedEscalationHours: saved.blockedEscalationHours,
    reviewWaitingThresholdHours: saved.reviewWaitingThresholdHours,
    overdueEscalationWorkingDays: saved.overdueEscalationWorkingDays,
    digestTime: saved.digestTime.slice(0, 5),
    quietHoursStart: saved.quietHoursStart,
    quietHoursEnd: saved.quietHoursEnd,
  }));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const set = <K extends keyof UpdateOrgSettingsInput>(key: K, value: UpdateOrgSettingsInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const timezones = COMMON_TIMEZONES.includes(form.timezone ?? '')
    ? COMMON_TIMEZONES
    : [form.timezone as string, ...COMMON_TIMEZONES];

  return (
    <AdminPage
      title="Organisation"
      description="Working days, working hours and the thresholds that decide when the system starts chasing people."
    >
      <Banner {...banner.props} />

      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setFieldErrors({});

          try {
            await save.mutateAsync(form);

            const rescheduled =
              saved.timezone !== form.timezone || saved.digestTime.slice(0, 5) !== form.digestTime;

            banner.show(
              'success',
              rescheduled
                ? 'Saved. The digest and the nightly alerts have been rescheduled to match.'
                : 'Saved.',
            );
          } catch (cause) {
            if (cause instanceof ApiError) setFieldErrors(cause.fieldErrors());
            banner.show(
              'error',
              cause instanceof Error ? cause.message : 'Those settings were not saved.',
            );
          }
        }}
      >
        <Card className="space-y-4 p-4">
          <h2 className="text-sm font-semibold">The working week</h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Time zone"
              hint="every date in the app is read in this zone"
              error={fieldErrors.timezone}
            >
              <Select
                value={form.timezone}
                onChange={(event) => set('timezone', event.target.value)}
              >
                {timezones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="The week starts on" error={fieldErrors.weekStartsOn}>
              <Select
                value={String(form.weekStartsOn)}
                onChange={(event) => set('weekStartsOn', Number(event.target.value))}
              >
                {WEEKDAY_NAMES.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <fieldset>
            <legend className="mb-1.5 block text-xs font-medium text-ink-muted">
              Weekend days
              <span className="ml-1 font-normal text-ink-faint">not counted as working days</span>
            </legend>
            <div className="flex flex-wrap gap-3">
              {WEEKDAY_NAMES.map((day, index) => (
                <label key={day} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={(form.weekendDays ?? []).includes(index)}
                    onChange={(event) =>
                      set(
                        'weekendDays',
                        event.target.checked
                          ? [...(form.weekendDays ?? []), index].sort((a, b) => a - b)
                          : (form.weekendDays ?? []).filter((d) => d !== index),
                      )
                    }
                  />
                  {day.slice(0, 3)}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Working hours in a day"
              hint="used for estimates and workload"
              error={fieldErrors.workHoursPerDay}
            >
              <Input
                type="number"
                min={1}
                max={24}
                step={0.5}
                value={form.workHoursPerDay}
                onChange={(event) => set('workHoursPerDay', Number(event.target.value))}
              />
            </Field>
          </div>
        </Card>

        <Card className="space-y-4 p-4">
          <h2 className="text-sm font-semibold">When to chase</h2>
          <p className="text-xs text-ink-faint">
            All of these are counted in working hours, so a weekend does not make a task look
            neglected.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="No update after"
              hint="working hours"
              error={fieldErrors.noUpdateThresholdHours}
            >
              <Input
                type="number"
                min={1}
                max={336}
                value={form.noUpdateThresholdHours}
                onChange={(event) => set('noUpdateThresholdHours', Number(event.target.value))}
              />
            </Field>

            <Field
              label="Blocked escalates after"
              hint="working hours"
              error={fieldErrors.blockedEscalationHours}
            >
              <Input
                type="number"
                min={1}
                max={336}
                value={form.blockedEscalationHours}
                onChange={(event) => set('blockedEscalationHours', Number(event.target.value))}
              />
            </Field>

            <Field
              label="Review waiting after"
              hint="working hours"
              error={fieldErrors.reviewWaitingThresholdHours}
            >
              <Input
                type="number"
                min={1}
                max={336}
                value={form.reviewWaitingThresholdHours}
                onChange={(event) => set('reviewWaitingThresholdHours', Number(event.target.value))}
              />
            </Field>

            <Field
              label="Overdue escalates after"
              hint="working days"
              error={fieldErrors.overdueEscalationWorkingDays}
            >
              <Input
                type="number"
                min={1}
                max={30}
                value={form.overdueEscalationWorkingDays}
                onChange={(event) =>
                  set('overdueEscalationWorkingDays', Number(event.target.value))
                }
              />
            </Field>
          </div>
        </Card>

        <Card className="space-y-4 p-4">
          <h2 className="text-sm font-semibold">Email timing</h2>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Daily digest at" error={fieldErrors.digestTime}>
              <Input
                type="time"
                value={form.digestTime}
                onChange={(event) => set('digestTime', event.target.value)}
              />
            </Field>

            <Field label="Quiet hours from" error={fieldErrors.quietHoursStart}>
              <Select
                value={String(form.quietHoursStart)}
                onChange={(event) => set('quietHoursStart', Number(event.target.value))}
              >
                {hours()}
              </Select>
            </Field>

            <Field label="Quiet hours until" error={fieldErrors.quietHoursEnd}>
              <Select
                value={String(form.quietHoursEnd)}
                onChange={(event) => set('quietHoursEnd', Number(event.target.value))}
              >
                {hours()}
              </Select>
            </Field>
          </div>

          <p className="text-xs text-ink-faint">
            Quiet hours are read in each person's own time zone, not this one. Set both to the same
            hour to send email at any time.
          </p>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending}>
            Save settings
          </Button>
        </div>
      </form>
    </AdminPage>
  );
}

function hours() {
  return Array.from({ length: 24 }, (_, hour) => (
    <option key={hour} value={hour}>
      {String(hour).padStart(2, '0')}:00
    </option>
  ));
}
