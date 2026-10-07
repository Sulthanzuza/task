import { useState } from 'react';
import { Link } from 'react-router-dom';
import { UserMinus, UserPlus } from 'lucide-react';
import type { GroupChild, TaskDetail } from '@tm/shared';
import { useAuth } from '@/features/auth/AuthContext';
import { Button, Card, Label } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DataTable, type Column } from '@/components/common/table';
import {
  DueBadge,
  ProgressBar,
  RelativeTime,
  StatusBadge,
  UserAvatar,
} from '@/components/common/badges';
import { useAddGroupMember, useRemoveGroupMember } from './api';
import { PersonPicker } from './PersonPicker';
import { cn, todayIso } from '@/lib/utils';

/**
 * Who is on a group task, and how each of them is getting on.
 *
 * The group's own row carries no work: this table is the whole point of
 * opening it. One line per person, each linking to their real task, so a
 * lead can see at a glance who is stuck without opening eight pages.
 */

const COLUMNS: Column[] = [
  { label: 'Person', width: 'auto' },
  { label: 'Task', width: '7rem' },
  { label: 'Status', width: '10rem' },
  { label: 'Progress', width: '8.5rem' },
  { label: 'Due', width: '7rem' },
  { label: 'Last update', width: '8rem', hideBelow: 'md' },
  { label: 'Actions', width: '5rem', align: 'right' },
];

/** "5 of 8 done · 2 in progress · 1 blocked", from the rows themselves. */
function summarise(children: GroupChild[], today: string): string {
  const live = children.filter((child) => child.status !== 'CANCELLED');
  const done = live.filter((child) => child.status === 'COMPLETED').length;
  const started = live.filter((child) => child.status === 'IN_PROGRESS').length;
  const blocked = live.filter((child) => child.status === 'BLOCKED').length;
  const overdue = live.filter(
    (child) => child.dueDate !== null && child.dueDate < today && child.status !== 'COMPLETED',
  ).length;

  const parts = [done + ' of ' + live.length + ' done'];
  if (started > 0) parts.push(started + ' in progress');
  if (blocked > 0) parts.push(blocked + ' blocked');
  if (overdue > 0) parts.push(overdue + ' overdue');
  // Said separately: somebody taken off is not part of the denominator and
  // reading it inside the fraction would be wrong.
  const left = children.length - live.length;
  if (left > 0) parts.push(left + ' removed');

  return parts.join(' · ');
}

export function GroupPeople({ task }: { task: TaskDetail }) {
  const { isLead } = useAuth();
  const add = useAddGroupMember(task.id);
  const remove = useRemoveGroupMember(task.id);

  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<GroupChild | null>(null);
  const [error, setError] = useState<string | null>(null);

  const today = todayIso();
  const already = task.groupChildren
    .filter((child) => child.status !== 'CANCELLED')
    .map((child) => child.assignee?.id)
    .filter((id): id is string => !!id);

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle p-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">People</h2>
          <p className="mt-0.5 text-xs text-ink-muted">{summarise(task.groupChildren, today)}</p>
        </div>

        {isLead ? (
          <div className="ml-auto flex items-center gap-2">
            {adding ? (
              <>
                <div className="w-52">
                  <Label>Add somebody</Label>
                  <PersonPicker
                    label="Add somebody to this group"
                    nobodyLabel="Choose a person"
                    value={null}
                    exclude={already}
                    disabled={add.isPending}
                    onChange={(id) => {
                      if (!id) return;
                      setError(null);
                      add.mutate(id, {
                        onSuccess: () => setAdding(false),
                        onError: (cause) =>
                          setError(cause instanceof Error ? cause.message : 'That did not work.'),
                      });
                    }}
                  />
                </div>
                <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                <UserPlus size={13} aria-hidden />
                Add somebody
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="px-4 pt-3 text-xs text-danger">
          {error}
        </p>
      ) : null}

      <DataTable columns={isLead ? COLUMNS : COLUMNS.slice(0, -1)} minWidth="46rem">
        <tbody className="divide-y divide-border-subtle">
          {task.groupChildren.map((child) => (
            <tr
              key={child.id}
              className={cn('hover:bg-surface-muted', child.status === 'CANCELLED' && 'opacity-60')}
            >
              <td className="px-3 py-2.5">
                <UserAvatar user={child.assignee} size="sm" showName />
              </td>
              <td className="px-3 py-2.5">
                <Link
                  to={'/tasks/' + child.key}
                  className="font-mono text-xs text-accent hover:underline"
                >
                  {child.key}
                </Link>
              </td>
              <td className="px-3 py-2.5">
                <StatusBadge status={child.status} />
              </td>
              <td className="px-3 py-2.5">
                <ProgressBar value={child.progress} label={child.key + ' progress'} />
              </td>
              <td className="px-3 py-2.5">
                <DueBadge dueDate={child.dueDate} status={child.status} emptyLabel={null} />
              </td>
              <td className="hidden px-3 py-2.5 text-xs text-ink-muted md:table-cell">
                <RelativeTime iso={child.lastActivityAt} />
              </td>
              {isLead ? (
                <td className="px-3 py-2.5 text-right">
                  {child.status === 'CANCELLED' ? null : (
                    <button
                      type="button"
                      aria-label={'Take ' + (child.assignee?.name ?? 'them') + ' off this group'}
                      className="text-ink-faint hover:text-danger"
                      onClick={() => setRemoving(child)}
                    >
                      <UserMinus size={14} />
                    </button>
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </DataTable>

      {task.groupChildren.length === 0 ? (
        <p className="p-4 text-xs text-ink-faint">Nobody is on this group yet.</p>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title={'Take ' + (removing?.assignee?.name ?? 'them') + ' off this group?'}
        description={
          'Their task ' +
          (removing?.key ?? '') +
          ' is cancelled, not deleted: the work they did and anything they said on it stays on ' +
          'the record. The group stops waiting for them.'
        }
        confirmLabel="Take them off"
        cancelLabel="Keep them on"
        busy={remove.isPending}
        error={error}
        onConfirm={() => {
          const id = removing?.assignee?.id;
          if (!id) return;
          setError(null);
          remove.mutate(id, {
            onSuccess: () => setRemoving(null),
            onError: (cause) =>
              setError(cause instanceof Error ? cause.message : 'That did not work.'),
          });
        }}
        onCancel={() => {
          setRemoving(null);
          setError(null);
        }}
      />
    </Card>
  );
}

/** The line a child shows, pointing back at the group it belongs to. */
export function GroupLink({ parentKey }: { parentKey: string }) {
  return (
    <Link
      to={'/tasks/' + parentKey}
      className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-[11px] text-ink-muted hover:text-accent"
    >
      Group: <span className="font-mono">{parentKey}</span>
    </Link>
  );
}
