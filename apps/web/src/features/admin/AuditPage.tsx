import { useState } from 'react';
import type { AuditEntryView, ListAuditQuery } from '@tm/shared';
import { useAdminPeople, useAudit } from './api';
import { AdminPage, Field } from './shared';
import { Button, Card, EmptyState, Input, Select, Skeleton } from '@/components/ui/primitives';

/**
 * Who did what, and when.
 *
 * The rows are read-only by design: an audit log an administrator can edit is
 * not evidence of anything.
 */

export function AuditPage() {
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const filters: ListAuditQuery = {
    ...(actorId ? { actorId } : {}),
    ...(action ? { action } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };

  const audit = useAudit(filters);
  const people = useAdminPeople({});

  const anyFilter = actorId !== '' || action !== '' || from !== '' || to !== '';

  return (
    <AdminPage
      title="Audit"
      description="Every administrative action: who changed a role, who altered the settings, who imported what."
    >
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Who">
            <Select
              aria-label="Filter by person"
              value={actorId}
              onChange={(event) => setActorId(event.target.value)}
            >
              <option value="">Anybody</option>
              {people.data?.items.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="What">
            <Select
              aria-label="Filter by action"
              value={action}
              onChange={(event) => setAction(event.target.value)}
            >
              <option value="">Anything</option>
              {(audit.data?.actions ?? []).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="From">
            <Input
              type="date"
              aria-label="From date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </Field>

          <Field label="To">
            <Input
              type="date"
              aria-label="To date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </Field>
        </div>

        {anyFilter ? (
          <div className="mt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setActorId('');
                setAction('');
                setFrom('');
                setTo('');
              }}
            >
              Clear the filters
            </Button>
          </div>
        ) : null}
      </Card>

      {audit.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : audit.data?.items.length ? (
        <Card className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Administrative actions</caption>
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs text-ink-faint">
                <th scope="col" className="px-3 py-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Who
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  What
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {audit.data.items.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <Card>
          <EmptyState
            title={anyFilter ? 'Nothing matches those filters' : 'Nothing has been recorded yet'}
            description={
              anyFilter
                ? 'Widen the dates, or clear the filters.'
                : 'Role changes, settings changes and imports will appear here as they happen.'
            }
          />
        </Card>
      )}
    </AdminPage>
  );
}

function AuditRow({ entry }: { entry: AuditEntryView }) {
  const [open, setOpen] = useState(false);
  const hasDetail = entry.before !== null || entry.after !== null;

  return (
    <>
      <tr>
        <td className="px-3 py-2 align-top whitespace-nowrap text-xs text-ink-muted">
          {new Date(entry.createdAt).toLocaleString()}
        </td>
        <td className="px-3 py-2 align-top">
          <span className="block">{entry.actorName ?? 'Someone since deleted'}</span>
          {entry.actorEmail ? (
            <span className="block text-xs text-ink-faint">{entry.actorEmail}</span>
          ) : null}
        </td>
        <td className="px-3 py-2 align-top">
          <span className="font-mono text-xs">{entry.action}</span>
          <span className="block text-xs text-ink-faint">{entry.subjectType}</span>
        </td>
        <td className="px-3 py-2 align-top">
          {hasDetail ? (
            <Button variant="ghost" size="sm" onClick={() => setOpen((shown) => !shown)}>
              {open ? 'Hide' : 'Show'}
            </Button>
          ) : (
            <span className="text-xs text-ink-faint">—</span>
          )}
          {entry.ip ? <span className="block text-xs text-ink-faint">{entry.ip}</span> : null}
        </td>
      </tr>

      {open ? (
        <tr>
          <td colSpan={4} className="bg-surface-muted px-3 py-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <Snapshot label="Before" value={entry.before} />
              <Snapshot label="After" value={entry.after} />
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Snapshot({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-ink-muted">{label}</p>
      <pre className="relative overflow-x-auto rounded-lg bg-surface p-2 text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
