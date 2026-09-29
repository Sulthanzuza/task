import { useMemo, useState } from 'react';
import { parseHolidayLines, type CreateHolidayInput, type Holiday } from '@tm/shared';
import { useAddHoliday, useAddHolidaysBulk, useHolidays, useRemoveHoliday } from './api';
import { AdminPage, Banner, Field, useBanner } from './shared';
import { ConfirmDialog, useConfirm } from '@/components/ui/ConfirmDialog';
import {
  Button,
  Card,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';

/**
 * The holiday calendar.
 *
 * Nobody types a year of holidays one row at a time, so the paste box is the
 * main way in and the single-day form is the exception. What will be added is
 * shown before anything is sent, with the unreadable lines named.
 */

export function HolidaysPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState<number | ''>(thisYear);

  const holidays = useHolidays(year === '' ? undefined : year);
  const addOne = useAddHoliday();
  const removeOne = useRemoveHoliday();
  const banner = useBanner();

  const [date, setDate] = useState('');
  const [name, setName] = useState('');

  const removal = useConfirm<Holiday>();

  // The usual span, plus whatever year is being looked at, so choosing a year
  // outside it does not leave the dropdown showing nothing.
  const years = useMemo(() => {
    const span = [thisYear - 1, thisYear, thisYear + 1, thisYear + 2];
    if (year !== '' && !span.includes(year)) span.push(year);
    return span.sort((a, b) => a - b);
  }, [thisYear, year]);

  return (
    <AdminPage
      title="Holidays"
      description="Days nobody is expected to work. Due dates, overdue alerts and workload all skip them."
    >
      <Banner {...banner.props} />

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">Add one day</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              const result = await addOne.mutateAsync({ date, name: name.trim() });
              banner.show(
                'success',
                result.added === 1
                  ? name.trim() + ' has been added.'
                  : 'That day was already a holiday.',
              );
              // Show the year it was added to, or a day added to next year
              // would vanish the moment it was saved.
              setYear(Number(date.slice(0, 4)));
              setDate('');
              setName('');
            } catch (error) {
              banner.show('error', error instanceof Error ? error.message : 'That did not work.');
            }
          }}
        >
          <Field label="Date">
            <Input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
            />
          </Field>
          <div className="min-w-48 flex-1">
            <Field label="Name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Republic Day"
                required
              />
            </Field>
          </div>
          <Button type="submit" disabled={addOne.isPending}>
            Add
          </Button>
        </form>
      </Card>

      <BulkAdd
        onDone={(message) => {
          // A pasted list can span years, so show all of them rather than
          // hiding most of what was just added behind the year filter.
          setYear('');
          banner.show('success', message);
        }}
        onFailed={(message) => banner.show('error', message)}
      />

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">The calendar</h2>
          <Select
            aria-label="Show a year"
            value={String(year)}
            onChange={(event) =>
              setYear(event.target.value === '' ? '' : Number(event.target.value))
            }
            className="w-40"
          >
            <option value="">Every year</option>
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </div>

        {holidays.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : holidays.data?.items.length ? (
          <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
            {holidays.data.items.map((holiday) => (
              <li key={holiday.date} className="flex items-center gap-3 px-3 py-2">
                <span className="w-28 shrink-0 font-mono text-xs text-ink-muted">
                  {holiday.date}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{holiday.name}</span>
                <span className="hidden text-xs text-ink-faint sm:inline">
                  {weekdayOf(holiday.date)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  onClick={() => removal.ask(holiday)}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="No holidays recorded"
            description="Paste a year's list above, and every working-day calculation will start skipping them."
          />
        )}
      </Card>

      <ConfirmDialog
        open={removal.open}
        title={'Delete ' + (removal.target?.name ?? '') + '?'}
        description="It becomes an ordinary working day again, which moves any due date that was counted around it."
        confirmLabel="Delete"
        busy={removal.busy}
        error={removal.error}
        onCancel={removal.cancel}
        onConfirm={() => {
          void removal.run(async (holiday) => {
            await removeOne.mutateAsync(holiday.date);
            banner.show('success', holiday.name + ' is a working day again.');
          });
        }}
      />
    </AdminPage>
  );
}

/** The date is already known to be valid, so this cannot throw. */
function weekdayOf(date: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(date + 'T00:00:00Z'),
  );
}

function BulkAdd({
  onDone,
  onFailed,
}: {
  onDone(message: string): void;
  onFailed(message: string): void;
}) {
  const addMany = useAddHolidaysBulk();
  const [text, setText] = useState('');

  const parsed = useMemo(() => parseHolidayLines(text), [text]);

  return (
    <Card className="p-4">
      <h2 className="mb-1 text-sm font-semibold">Add a year at once</h2>
      <p className="mb-3 text-xs text-ink-faint">
        One per line: the date, then the name. Commas, semicolons and tabs all work, so a CSV pasted
        straight from a spreadsheet is fine.
      </p>

      <Textarea
        aria-label="Holidays to add"
        rows={6}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={'2026-01-26, Republic Day\n2026-08-15, Independence Day'}
        className="font-mono text-xs"
      />

      {text.trim() !== '' ? (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-ink-muted">
            {parsed.items.length} {parsed.items.length === 1 ? 'day' : 'days'} ready
            {parsed.problems.length > 0
              ? ', ' +
                parsed.problems.length +
                ' line' +
                (parsed.problems.length === 1 ? '' : 's') +
                ' could not be read'
              : ''}
            .
          </p>

          {parsed.problems.length > 0 ? (
            <ul className="space-y-1 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
              {parsed.problems.slice(0, 8).map((problem) => (
                <li key={problem.line}>
                  Line {problem.line}: {problem.message} — “{problem.text}”
                </li>
              ))}
              {parsed.problems.length > 8 ? <li>and {parsed.problems.length - 8} more.</li> : null}
            </ul>
          ) : null}

          {parsed.items.length > 0 ? (
            <ul className="max-h-40 overflow-y-auto rounded-lg border border-border-subtle text-xs">
              {parsed.items.map((item: CreateHolidayInput) => (
                <li
                  key={item.date}
                  className="flex gap-3 border-b border-border-subtle px-3 py-1 last:border-0"
                >
                  <span className="w-24 font-mono text-ink-muted">{item.date}</span>
                  <span className="truncate">{item.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex justify-end">
        <Button
          disabled={parsed.items.length === 0 || addMany.isPending}
          onClick={async () => {
            try {
              const result = await addMany.mutateAsync(parsed.items);
              onDone(
                result.added +
                  (result.added === 1 ? ' day was added' : ' days were added') +
                  (result.alreadyThere > 0
                    ? '; ' + result.alreadyThere + ' were already there'
                    : '') +
                  '.',
              );
              setText('');
            } catch (error) {
              onFailed(error instanceof Error ? error.message : 'Those days were not added.');
            }
          }}
        >
          Add {parsed.items.length > 0 ? parsed.items.length : ''}{' '}
          {parsed.items.length === 1 ? 'day' : 'days'}
        </Button>
      </div>
    </Card>
  );
}
