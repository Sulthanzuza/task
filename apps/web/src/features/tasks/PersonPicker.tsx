import { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { UserSummary } from '@tm/shared';
import { useDashboardMembers } from '@/features/dashboard/api';
import { useAuth } from '@/features/auth/AuthContext';
import { useUsers } from '@/features/team/api';
import { UserAvatar } from '@/components/common/badges';
import { Input } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * Choosing a person, with the one fact that decides it.
 *
 * A lead picking an assignee is really asking "who has room?", and a plain
 * list of names does not answer that. Each row carries the person's open
 * count, so the question is answered where the choice is made rather than on
 * a dashboard in another tab.
 *
 * The counts come from the team stats the dashboard already loads, so this
 * costs a cache hit rather than a request. They are decoration: if they are
 * not there, or the person is not on the lead's team, the row still works.
 */

export interface PersonChoice {
  id: string | null;
  name: string;
}

export function usePeopleWithCounts(teamId?: string) {
  const { isLead } = useAuth();
  const people = useUsers();
  // Members may not read team stats, so do not ask on their behalf.
  const members = useDashboardMembers(teamId, isLead);

  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const member of members.data?.items ?? []) counts.set(member.user.id, member.active);

    return (people.data?.items ?? []).map((person) => ({
      person,
      open: counts.get(person.id) ?? null,
    }));
  }, [people.data, members.data]);
}

/**
 * The same picker, for several people at once.
 *
 * Used to give one piece of work to a whole team, where each of them ends
 * up with their own copy. Kept beside the single picker rather than folded
 * into it: "who owns this" and "who is all doing this" are different
 * questions, and a control that silently answers both is how somebody
 * creates eight tasks when they meant one.
 */
export function PeoplePicker({
  value,
  onChange,
  label,
  teamId,
  disabled = false,
  className,
}: {
  value: string[];
  onChange(ids: string[]): void;
  label: string;
  teamId?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const people = usePeopleWithCounts(teamId);

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? people.filter(({ person }) => person.name.toLowerCase().includes(needle))
    : people;

  const chosen = people.filter(({ person }) => value.includes(person.id));

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((other) => other !== id) : [...value, id]);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Popover.Trigger
        disabled={disabled}
        aria-label={label + (chosen.length === 0 ? ': nobody' : ': ' + chosen.length + ' people')}
        className={cn(
          'flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-input)] border',
          'border-border-subtle bg-surface-muted px-2.5 py-1 text-sm text-ink transition-colors',
          'hover:border-border-strong focus-visible:border-accent focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-70',
          className,
        )}
      >
        {chosen.length === 0 ? (
          <span className="text-ink-faint">Nobody yet</span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {chosen.map(({ person }) => (
              <UserAvatar key={person.id} user={person} size="sm" />
            ))}
            <span className="ml-1 text-xs text-ink-muted">{chosen.length}</span>
          </span>
        )}
        <ChevronDown size={14} aria-hidden className="ml-auto shrink-0 text-ink-faint" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-72 rounded-[var(--radius-card)] border border-border-subtle bg-surface p-1.5 shadow-xl"
        >
          <div className="relative mb-1.5">
            <Search
              size={13}
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint"
            />
            <Input
              autoFocus
              aria-label={'Search for people to add to ' + label.toLowerCase()}
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 pl-7 text-xs"
            />
          </div>

          <ul
            role="listbox"
            aria-multiselectable
            aria-label={label}
            className="max-h-64 overflow-y-auto"
          >
            {shown.map(({ person, open: openCount }) => (
              <Row
                key={person.id}
                selected={value.includes(person.id)}
                onSelect={() => toggle(person.id)}
                left={<UserAvatar user={person} size="sm" showName />}
                right={
                  openCount === null ? null : (
                    <span
                      className="tabular shrink-0 rounded-full bg-surface-muted px-1.5 py-0.5 text-[11px] text-ink-muted"
                      title={openCount + ' open ' + (openCount === 1 ? 'task' : 'tasks')}
                    >
                      {openCount} open
                    </span>
                  )
                }
              />
            ))}

            {shown.length === 0 ? (
              <li className="px-2 py-3 text-center text-xs text-ink-faint">Nobody matches.</li>
            ) : null}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function PersonPicker({
  value,
  onChange,
  label,
  teamId,
  disabled = false,
  allowNobody = true,
  nobodyLabel = 'Nobody',
  exclude,
  className,
}: {
  value: UserSummary | null;
  onChange(id: string | null): void;
  /**
   * People to leave out. Offering somebody who is already on a group only
   * to refuse the choice afterwards is a worse answer than not offering
   * them.
   */
  exclude?: string[];
  /** Names the control, since the trigger shows a person rather than a word. */
  label: string;
  teamId?: string;
  disabled?: boolean;
  allowNobody?: boolean;
  nobodyLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const people = usePeopleWithCounts(teamId);

  const needle = query.trim().toLowerCase();
  const offered = exclude?.length
    ? people.filter(({ person }) => !exclude.includes(person.id))
    : people;
  const shown = needle
    ? offered.filter(({ person }) => person.name.toLowerCase().includes(needle))
    : offered;

  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Popover.Trigger
        disabled={disabled}
        aria-label={label + (value ? ': ' + value.name : ': nobody')}
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-[var(--radius-input)] border',
          'border-border-subtle bg-surface-muted px-2.5 text-sm text-ink transition-colors',
          'hover:border-border-strong focus-visible:border-accent focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-70',
          className,
        )}
      >
        {value ? (
          <UserAvatar user={value} size="sm" showName />
        ) : (
          <span className="text-ink-faint">{nobodyLabel}</span>
        )}
        <ChevronDown size={14} aria-hidden className="ml-auto shrink-0 text-ink-faint" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-72 rounded-[var(--radius-card)] border border-border-subtle bg-surface p-1.5 shadow-xl"
        >
          <div className="relative mb-1.5">
            <Search
              size={13}
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint"
            />
            <Input
              autoFocus
              aria-label={'Search for a person to set as ' + label.toLowerCase()}
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 pl-7 text-xs"
            />
          </div>

          <ul role="listbox" aria-label={label} className="max-h-64 overflow-y-auto">
            {allowNobody ? (
              <Row
                selected={value === null}
                onSelect={() => choose(null)}
                left={<span className="text-sm text-ink-faint">{nobodyLabel}</span>}
              />
            ) : null}

            {shown.map(({ person, open: openCount }) => (
              <Row
                key={person.id}
                selected={value?.id === person.id}
                onSelect={() => choose(person.id)}
                left={<UserAvatar user={person} size="sm" showName />}
                right={
                  openCount === null ? null : (
                    <span
                      className="tabular shrink-0 rounded-full bg-surface-muted px-1.5 py-0.5 text-[11px] text-ink-muted"
                      title={openCount + ' open ' + (openCount === 1 ? 'task' : 'tasks')}
                    >
                      {openCount} open
                    </span>
                  )
                }
              />
            ))}

            {shown.length === 0 ? (
              <li className="px-2 py-3 text-center text-xs text-ink-faint">Nobody matches.</li>
            ) : null}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({
  selected,
  onSelect,
  left,
  right,
}: {
  selected: boolean;
  onSelect(): void;
  left: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <li role="option" aria-selected={selected}>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
          'hover:bg-surface-muted',
          selected && 'bg-accent-soft',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{left}</span>
        {right}
        <Check
          size={13}
          aria-hidden
          className={cn('shrink-0 text-accent', selected ? 'opacity-100' : 'opacity-0')}
        />
      </button>
    </li>
  );
}
