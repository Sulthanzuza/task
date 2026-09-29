import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { TeamDetail, UserSummary } from '@tm/shared';
import {
  useAddTeamMember,
  useAdminPeople,
  useAdminTeams,
  useCreateTeam,
  useRemoveTeamMember,
  useUpdateTeam,
} from './api';
import { AdminPage, Banner, Field, useBanner } from './shared';
import { ConfirmDialog, useConfirm } from '@/components/ui/ConfirmDialog';
import { Button, Card, EmptyState, Input, Select, Skeleton } from '@/components/ui/primitives';
import { UserAvatar } from '@/components/common/badges';

/** Teams: who is in them, and who leads them. */

export function TeamsPage() {
  const teams = useAdminTeams();
  const everyone = useAdminPeople({ active: true });
  const createTeam = useCreateTeam();
  const banner = useBanner();

  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  return (
    <AdminPage
      title="Teams"
      description="A team decides who sees which projects and whose dashboard a person appears on."
      action={
        <Button onClick={() => setCreating((open) => !open)}>
          <Plus size={15} aria-hidden /> New team
        </Button>
      }
    >
      <Banner {...banner.props} />

      {creating ? (
        <Card className="p-4">
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                await createTeam.mutateAsync({ name: newName.trim() });
                banner.show('success', newName.trim() + ' has been created.');
                setNewName('');
                setCreating(false);
              } catch (error) {
                banner.show('error', error instanceof Error ? error.message : 'That did not work.');
              }
            }}
          >
            <div className="min-w-56 flex-1">
              <Field label="Team name">
                <Input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="Platform"
                  required
                />
              </Field>
            </div>
            <Button type="submit" disabled={createTeam.isPending}>
              Create
            </Button>
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </form>
        </Card>
      ) : null}

      {teams.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : teams.data?.items.length ? (
        teams.data.items.map((team) => (
          <TeamCard
            key={team.id}
            team={team}
            everyone={everyone.data?.items ?? []}
            onSaved={(message) => banner.show('success', message)}
            onFailed={(message) => banner.show('error', message)}
          />
        ))
      ) : (
        <Card>
          <EmptyState
            title="No teams yet"
            description="Create one, then add people to it from here or from the People screen."
          />
        </Card>
      )}
    </AdminPage>
  );
}

function TeamCard({
  team,
  everyone,
  onSaved,
  onFailed,
}: {
  team: TeamDetail;
  everyone: UserSummary[];
  onSaved(message: string): void;
  onFailed(message: string): void;
}) {
  const updateTeam = useUpdateTeam();
  const addMember = useAddTeamMember();
  const removeMember = useRemoveTeamMember();

  const [name, setName] = useState(team.name);
  const removal = useConfirm<UserSummary>();

  const notMembers = everyone.filter((person) => !team.members.some((m) => m.id === person.id));

  const fail = (error: unknown) =>
    onFailed(error instanceof Error ? error.message : 'That did not work.');

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <Field label="Name">
            <Input
              aria-label={'Name of ' + team.name}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={async () => {
                const trimmed = name.trim();
                if (trimmed === team.name || trimmed.length < 2) {
                  setName(team.name);
                  return;
                }
                try {
                  await updateTeam.mutateAsync({ teamId: team.id, name: trimmed });
                  onSaved('The team is now called ' + trimmed + '.');
                } catch (error) {
                  setName(team.name);
                  fail(error);
                }
              }}
            />
          </Field>
        </div>

        <div className="min-w-48 flex-1">
          <Field label="Lead" hint="decides who may change tasks">
            <Select
              aria-label={'Lead of ' + team.name}
              value={team.leadId ?? ''}
              onChange={async (event) => {
                const chosen = event.target.value;
                try {
                  await updateTeam.mutateAsync({
                    teamId: team.id,
                    leadId: chosen === '' ? null : chosen,
                  });
                  onSaved(
                    chosen === ''
                      ? team.name + ' has no lead.'
                      : 'The lead of ' + team.name + ' has changed.',
                  );
                } catch (error) {
                  fail(error);
                }
              }}
            >
              <option value="">Nobody yet</option>
              {everyone.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      <h3 className="mt-4 mb-2 text-xs font-medium text-ink-muted">
        Members ({team.members.length})
      </h3>

      <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
        {team.members.length === 0 ? (
          <li className="px-3 py-3 text-sm text-ink-faint">Nobody is on this team yet.</li>
        ) : (
          team.members.map((member) => (
            <li key={member.id} className="flex items-center gap-2.5 px-3 py-2">
              <UserAvatar user={member} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{member.name}</p>
                <p className="truncate text-xs text-ink-faint">{member.email}</p>
              </div>
              {member.id === team.leadId ? (
                <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">
                  Lead
                </span>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="text-danger"
                onClick={() => removal.ask(member)}
              >
                Remove
              </Button>
            </li>
          ))
        )}
      </ul>

      <div className="mt-3 max-w-xs">
        <Select
          aria-label={'Add somebody to ' + team.name}
          value=""
          onChange={async (event) => {
            const chosen = event.target.value;
            if (!chosen) return;
            try {
              await addMember.mutateAsync({ teamId: team.id, userId: chosen });
              onSaved('They have joined ' + team.name + '.');
            } catch (error) {
              fail(error);
            }
          }}
        >
          <option value="">Add somebody…</option>
          {notMembers.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
      </div>

      <ConfirmDialog
        open={removal.open}
        title={'Remove ' + (removal.target?.name ?? '') + ' from ' + team.name + '?'}
        description="They keep their tasks, but they will no longer see this team's projects or appear on its dashboard."
        confirmLabel="Remove"
        busy={removal.busy}
        error={removal.error}
        onCancel={removal.cancel}
        onConfirm={() => {
          void removal.run(async (member) => {
            await removeMember.mutateAsync({ teamId: team.id, userId: member.id });
            onSaved(member.name + ' has left ' + team.name + '.');
          });
        }}
      />
    </Card>
  );
}
