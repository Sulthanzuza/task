import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, KeyRound, Link2, Mail, Plus, Search } from 'lucide-react';
import {
  ROLE_LABELS,
  USER_ROLES,
  type IssuedLink,
  type UserRole,
  type UserSummary,
} from '@tm/shared';
import {
  useAddTeamMember,
  useAdminPeople,
  useAdminTeams,
  useInviteUser,
  useIssueResetLink,
  useRemoveTeamMember,
  useResendInvite,
  useSetUserActive,
  useUpdateUser,
} from './api';
import { useAuthOptions } from '@/features/auth/api';
import { AdminPage, Banner, Field, useBanner } from './shared';
import { ConfirmDialog, useConfirm } from '@/components/ui/ConfirmDialog';
import { Button, Card, EmptyState, Input, Select, Skeleton } from '@/components/ui/primitives';
import { UserAvatar } from '@/components/common/badges';
import { ApiError } from '@/lib/api';
import { DataTable, type Column } from '@/components/common/table';

/**
 * Everyone in the organisation, and what an admin does to them: invite, change
 * their role or team, issue a new invitation or a password reset link, and
 * switch the account off.
 *
 * Every invitation and reset produces a link the admin can copy, email or no
 * email. With email off (MAIL_TRANSPORT=none) that link is the only way in;
 * with email on it rescues an invitation that went to spam.
 */

/** A link on screen, and who it is for. */
interface ShownLink {
  kind: 'invite' | 'reset';
  name: string;
  link: IssuedLink;
  /** Whether it was also emailed to them. */
  emailed: boolean;
}

export function PeoplePage() {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<UserRole | ''>('');
  const [teamId, setTeamId] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [inviting, setInviting] = useState(false);

  const banner = useBanner();
  const teams = useAdminTeams();

  const people = useAdminPeople({
    ...(query.trim() ? { q: query.trim() } : {}),
    ...(role ? { role } : {}),
    ...(teamId ? { teamId } : {}),
    ...(showInactive ? {} : { active: true }),
  });

  const setActive = useSetUserActive();
  const resend = useResendInvite();
  const resetLink = useIssueResetLink();
  const emailOn = useAuthOptions().data?.email ?? false;
  const [shown, setShown] = useState<ShownLink | null>(null);

  const deactivation = useConfirm<UserSummary>();

  return (
    <AdminPage
      title="People"
      description="Invite colleagues, set what they may do, and switch off accounts that should no longer sign in."
      action={
        <Button onClick={() => setInviting(true)}>
          <Plus size={15} aria-hidden /> Invite someone
        </Button>
      }
    >
      <Banner {...banner.props} />

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative">
            <Search
              size={15}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
              aria-hidden
            />
            <Input
              aria-label="Search people"
              placeholder="Name or email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-9"
            />
          </div>

          <Select
            aria-label="Filter by role"
            value={role}
            onChange={(event) => setRole(event.target.value as UserRole | '')}
          >
            <option value="">Every role</option>
            {USER_ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]}
              </option>
            ))}
          </Select>

          <Select
            aria-label="Filter by team"
            value={teamId}
            onChange={(event) => setTeamId(event.target.value)}
          >
            <option value="">Every team</option>
            {teams.data?.items.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>

          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(event) => setShowInactive(event.target.checked)}
            />
            Include deactivated
          </label>
        </div>
      </Card>

      {people.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : people.data?.items.length ? (
        <Card className="p-0">
          <DataTable columns={PEOPLE_COLUMNS} minWidth="42rem">
            <tbody className="divide-y divide-border-subtle">
              {people.data.items.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  teams={teams.data?.items ?? []}
                  onAskDeactivate={() => deactivation.ask(person)}
                  onReactivate={async () => {
                    try {
                      await setActive.mutateAsync({ userId: person.id, active: true });
                      banner.show('success', person.name + ' can sign in again.');
                    } catch (error) {
                      banner.show('error', messageOf(error));
                    }
                  }}
                  emailOn={emailOn}
                  onResend={async () => {
                    try {
                      const result = await resend.mutateAsync(person.id);
                      setShown({
                        kind: 'invite',
                        name: person.name,
                        link: result.invite,
                        emailed: result.emailed,
                      });
                    } catch (error) {
                      banner.show('error', messageOf(error));
                    }
                  }}
                  onResetLink={async () => {
                    try {
                      const link = await resetLink.mutateAsync(person.id);
                      setShown({ kind: 'reset', name: person.name, link, emailed: false });
                    } catch (error) {
                      banner.show('error', messageOf(error));
                    }
                  }}
                  onSaved={(message) => banner.show('success', message)}
                  onFailed={(message) => banner.show('error', message)}
                />
              ))}
            </tbody>
          </DataTable>
        </Card>
      ) : (
        <Card>
          <EmptyState
            title="Nobody matches that"
            description="Try a different search, or clear the filters."
          />
        </Card>
      )}

      {inviting ? (
        <InviteDialog
          teams={teams.data?.items ?? []}
          emailOn={emailOn}
          onClose={() => setInviting(false)}
          onInvited={(name, link) => {
            setInviting(false);
            setShown({ kind: 'invite', name, link, emailed: emailOn });
          }}
        />
      ) : null}

      {shown ? <LinkDialog shown={shown} onClose={() => setShown(null)} /> : null}

      <ConfirmDialog
        open={deactivation.open}
        title={'Deactivate ' + (deactivation.target?.name ?? '') + '?'}
        description={
          <>
            <p>
              They will be signed out everywhere immediately and will not be able to sign in again.
            </p>
            <p className="mt-2">
              Their tasks, comments and history stay exactly as they are. You can switch the account
              back on at any time.
            </p>
          </>
        }
        confirmLabel="Deactivate"
        busy={deactivation.busy}
        error={deactivation.error}
        onCancel={deactivation.cancel}
        onConfirm={() => {
          void deactivation.run(async (person) => {
            await setActive.mutateAsync({ userId: person.id, active: false });
            banner.show('success', person.name + ' can no longer sign in.');
          });
        }}
      />
    </AdminPage>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'That did not work.';
}

interface PersonRowProps {
  person: UserSummary;
  teams: Array<{ id: string; name: string; members: UserSummary[]; leadId: string | null }>;
  onAskDeactivate(): void;
  onReactivate(): Promise<void>;
  onResend(): Promise<void>;
  onResetLink(): Promise<void>;
  emailOn: boolean;
  onSaved(message: string): void;
  onFailed(message: string): void;
}

const PEOPLE_COLUMNS: Column[] = [
  { label: 'Name', width: 'auto' },
  { label: 'Role', width: '12rem' },
  { label: 'Teams', width: '14rem', hideBelow: 'md' },
  { label: 'Actions', width: '19rem', align: 'right' },
];

function PersonRow({
  person,
  teams,
  onAskDeactivate,
  onReactivate,
  onResend,
  onResetLink,
  emailOn,
  onSaved,
  onFailed,
}: PersonRowProps) {
  const updateUser = useUpdateUser();
  const addMember = useAddTeamMember();
  const removeMember = useRemoveTeamMember();

  const theirTeams = teams.filter((team) => team.members.some((m) => m.id === person.id));

  return (
    <tr className={person.isActive ? '' : 'opacity-60'}>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <UserAvatar user={person} />
          <div className="min-w-0">
            <Link to={'/team/' + person.id} className="block truncate font-medium hover:underline">
              {person.name}
            </Link>
            <p className="truncate text-xs text-ink-faint">{person.email}</p>
          </div>
          {person.isActive ? null : (
            <span className="rounded-md bg-surface-muted px-1.5 py-0.5 text-[11px] text-ink-muted">
              Deactivated
            </span>
          )}
        </div>
      </td>

      <td className="px-3 py-2.5">
        <Select
          aria-label={'Role for ' + person.name}
          value={person.role}
          disabled={!person.isActive || updateUser.isPending}
          onChange={async (event) => {
            const next = event.target.value as UserRole;
            try {
              await updateUser.mutateAsync({ userId: person.id, role: next });
              onSaved(person.name + ' is now a ' + ROLE_LABELS[next].toLowerCase() + '.');
            } catch (error) {
              onFailed(messageOf(error));
            }
          }}
          className="w-36"
        >
          {USER_ROLES.map((value) => (
            <option key={value} value={value}>
              {ROLE_LABELS[value]}
            </option>
          ))}
        </Select>
      </td>

      <td className="hidden px-3 py-2.5 md:table-cell">
        <div className="flex flex-wrap items-center gap-1.5">
          {theirTeams.map((team) => (
            <span
              key={team.id}
              className="inline-flex items-center gap-1 rounded-md bg-surface-muted px-2 py-0.5 text-xs"
            >
              {team.name}
              <button
                type="button"
                aria-label={'Remove ' + person.name + ' from ' + team.name}
                className="text-ink-faint hover:text-danger"
                onClick={async () => {
                  try {
                    await removeMember.mutateAsync({ teamId: team.id, userId: person.id });
                    onSaved(person.name + ' has left ' + team.name + '.');
                  } catch (error) {
                    onFailed(messageOf(error));
                  }
                }}
              >
                ×
              </button>
            </span>
          ))}

          <Select
            aria-label={'Add ' + person.name + ' to a team'}
            value=""
            disabled={!person.isActive}
            onChange={async (event) => {
              const chosen = event.target.value;
              if (!chosen) return;
              try {
                await addMember.mutateAsync({ teamId: chosen, userId: person.id });
                onSaved(person.name + ' has joined the team.');
              } catch (error) {
                onFailed(messageOf(error));
              }
            }}
            className="h-7 w-28 text-xs"
          >
            <option value="">Add to…</option>
            {teams
              .filter((team) => !theirTeams.some((t) => t.id === team.id))
              .map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
          </Select>
        </div>
      </td>

      <td className="px-3 py-2.5">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            title={
              emailOn
                ? 'Email a new set-a-password link, and show it to copy'
                : 'Make a new set-a-password link to copy'
            }
            aria-label={(emailOn ? 'Resend invite to ' : 'New invite link for ') + person.name}
            disabled={!person.isActive}
            onClick={() => void onResend()}
          >
            {emailOn ? <Mail size={14} aria-hidden /> : <Link2 size={14} aria-hidden />}
            {emailOn ? 'Resend invite' : 'New invite link'}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            title="Make a one-time password reset link to copy"
            aria-label={'Reset link for ' + person.name}
            disabled={!person.isActive}
            onClick={() => void onResetLink()}
          >
            <KeyRound size={14} aria-hidden /> Reset link
          </Button>

          {person.isActive ? (
            <Button variant="ghost" size="sm" className="text-danger" onClick={onAskDeactivate}>
              Deactivate
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => void onReactivate()}>
              Reactivate
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function InviteDialog({
  teams,
  emailOn,
  onClose,
  onInvited,
}: {
  teams: Array<{ id: string; name: string }>;
  emailOn: boolean;
  onClose(): void;
  onInvited(name: string, link: IssuedLink): void;
}) {
  const invite = useInviteUser();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('MEMBER');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Invite someone"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <Card className="w-full max-w-md p-5">
        <h2 className="text-sm font-semibold">Invite someone</h2>
        <p className="mt-1 text-xs text-ink-faint">
          {emailOn
            ? 'They are emailed a link to choose their own password, and you get a copy of it. '
            : 'You get a link to send them yourself; they use it to choose their own password. '}
          No password is set here.
        </p>

        <form
          className="mt-4 space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setFieldErrors({});
            try {
              const created = await invite.mutateAsync({
                name: name.trim(),
                email: email.trim(),
                role,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                teamIds,
              });
              onInvited(name.trim(), created.invite);
            } catch (cause) {
              if (cause instanceof ApiError) {
                setFieldErrors(cause.fieldErrors());
                setError(cause.message);
              } else {
                setError(messageOf(cause));
              }
            }
          }}
        >
          <Field label="Name" error={fieldErrors.name}>
            <Input
              id="invite-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>

          <Field label="Email" error={fieldErrors.email}>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </Field>

          <Field label="Role" error={fieldErrors.role}>
            <Select
              id="invite-role"
              value={role}
              onChange={(event) => setRole(event.target.value as UserRole)}
            >
              {USER_ROLES.map((value) => (
                <option key={value} value={value}>
                  {ROLE_LABELS[value]}
                </option>
              ))}
            </Select>
          </Field>

          {teams.length > 0 ? (
            <fieldset>
              <legend className="mb-1.5 block text-xs font-medium text-ink-muted">Teams</legend>
              <div className="space-y-1">
                {teams.map((team) => (
                  <label key={team.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={teamIds.includes(team.id)}
                      onChange={(event) =>
                        setTeamIds((current) =>
                          event.target.checked
                            ? [...current, team.id]
                            : current.filter((id) => id !== team.id),
                        )
                      }
                    />
                    {team.name}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              Send the invitation
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

/**
 * The link, to copy and send by whatever channel the team uses. Shown once:
 * only its hash is stored, so closing this is the last chance to copy it, and
 * a new one can always be made (which retires this one).
 */
function LinkDialog({ shown, onClose }: { shown: ShownLink; onClose(): void }) {
  const [copied, setCopied] = useState(false);
  const label = shown.kind === 'invite' ? 'Invite link' : 'Reset link';
  const expires = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(shown.link.expiresAt));

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(shown.link.url);
      setCopied(true);
    } catch {
      // No clipboard permission: the field is selected, so Ctrl+C works.
      document.getElementById('issued-link')?.focus();
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label + ' for ' + shown.name}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <Card className="w-full max-w-lg p-5">
        <h2 className="text-sm font-semibold">
          {label} for {shown.name}
        </h2>
        <p className="mt-1 text-xs text-ink-muted">
          {shown.kind === 'invite'
            ? 'They open it to choose their password and sign in. '
            : 'They open it to choose a new password. Their old one keeps working until then. '}
          {shown.emailed ? 'It has also been emailed to them.' : 'Nothing has been emailed.'}
        </p>

        <div className="mt-4 flex gap-2">
          <Input
            id="issued-link"
            aria-label={label}
            readOnly
            value={shown.link.url}
            onFocus={(event) => event.target.select()}
            className="font-mono text-xs"
          />
          <Button onClick={() => void copy()} aria-label={'Copy ' + label.toLowerCase()}>
            <Copy size={14} aria-hidden /> {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <ul className="mt-3 space-y-1 text-xs text-ink-muted">
          <li>Works once, and until {expires}.</li>
          <li>
            Anyone holding it can set {shown.name}&rsquo;s password: send it to them directly, not
            to a group.
          </li>
          <li>Making another link retires this one. It is not shown again after you close this.</li>
        </ul>

        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </div>
      </Card>
    </div>
  );
}
