import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PROJECT_STATUSES, type Project, type ProjectStatus } from '@tm/shared';
import {
  useAdminProjects,
  useAdminTeams,
  useArchiveProject,
  useCreateProject,
  useUpdateProject,
} from './api';
import { AdminPage, Banner, Field, useBanner } from './shared';
import { ConfirmDialog, useConfirm } from '@/components/ui/ConfirmDialog';
import { useAuth } from '@/features/auth/AuthContext';
import {
  Button,
  Card,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Textarea,
} from '@/components/ui/primitives';
import { ApiError } from '@/lib/api';

/**
 * Projects.
 *
 * A lead sees this screen too, but only their own teams' projects are theirs
 * to change; the server decides that, and the form simply offers the teams
 * they lead. The key is set once and never again: it is printed on every task.
 */

export function ProjectsPage() {
  const { user, isAdmin } = useAuth();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  const projects = useAdminProjects(includeArchived);
  const teams = useAdminTeams();
  const banner = useBanner();

  // A lead may create a project only for a team they actually lead.
  const myTeams = (teams.data?.items ?? []).filter((team) => isAdmin || team.leadId === user?.id);

  return (
    <AdminPage
      title="Projects"
      description="Each project owns a key and a team. Tasks take the key, so it cannot change once work has started."
      action={
        myTeams.length > 0 ? (
          <Button onClick={() => setCreating((open) => !open)}>
            <Plus size={15} aria-hidden /> New project
          </Button>
        ) : null
      }
    >
      <Banner {...banner.props} />

      {creating ? (
        <CreateProjectForm
          teams={myTeams}
          onClose={() => setCreating(false)}
          onCreated={(project) => {
            setCreating(false);
            banner.show('success', project.key + ' — ' + project.name + ' has been created.');
          }}
        />
      ) : null}

      <label className="flex items-center gap-2 text-sm text-ink-muted">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
        />
        Include archived projects
      </label>

      {projects.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : projects.data?.items.length ? (
        <div className="space-y-3">
          {projects.data.items.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              teams={teams.data?.items ?? []}
              canEdit={isAdmin || myTeams.some((team) => team.id === project.teamId)}
              onSaved={(message) => banner.show('success', message)}
              onFailed={(message) => banner.show('error', message)}
            />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            title="No projects yet"
            description="Create one to give tasks somewhere to live and a key to be numbered by."
          />
        </Card>
      )}
    </AdminPage>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'That did not work.';
}

function CreateProjectForm({
  teams,
  onClose,
  onCreated,
}: {
  teams: Array<{ id: string; name: string }>;
  onClose(): void;
  onCreated(project: Project): void;
}) {
  const createProject = useCreateProject();

  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  return (
    <Card className="p-4">
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          setFieldErrors({});
          try {
            const created = await createProject.mutateAsync({
              key: key.trim().toUpperCase(),
              name: name.trim(),
              teamId,
              status: 'ACTIVE',
              ...(description.trim() ? { description: description.trim() } : {}),
            });
            onCreated(created);
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
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Key" hint="two to ten capitals, forever" error={fieldErrors.key}>
            <Input
              value={key}
              onChange={(event) => setKey(event.target.value.toUpperCase())}
              placeholder="ERP"
              maxLength={10}
              required
            />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Name" error={fieldErrors.name}>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Enterprise resource planning"
                required
              />
            </Field>
          </div>
        </div>

        <Field label="Team" error={fieldErrors.teamId}>
          <Select value={teamId} onChange={(event) => setTeamId(event.target.value)} required>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Description" hint="optional" error={fieldErrors.description}>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
          />
        </Field>

        {error ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={createProject.isPending}>
            Create the project
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ProjectCard({
  project,
  teams,
  canEdit,
  onSaved,
  onFailed,
}: {
  project: Project;
  teams: Array<{ id: string; name: string }>;
  canEdit: boolean;
  onSaved(message: string): void;
  onFailed(message: string): void;
}) {
  const updateProject = useUpdateProject();
  const archiveProject = useArchiveProject();

  const [name, setName] = useState(project.name);
  const archiving = useConfirm<Project>();

  const archived = project.archivedAt !== null;
  const teamName = teams.find((team) => team.id === project.teamId)?.name ?? 'No team';

  return (
    <Card className={'p-4 ' + (archived ? 'opacity-60' : '')}>
      <div className="flex flex-wrap items-start gap-3">
        <span
          className="rounded-md bg-surface-muted px-2 py-1 font-mono text-sm"
          title="The key cannot be changed"
        >
          {project.key}
        </span>

        <div className="min-w-48 flex-1">
          <Input
            aria-label={'Name of ' + project.key}
            value={name}
            disabled={!canEdit || archived}
            onChange={(event) => setName(event.target.value)}
            onBlur={async () => {
              const trimmed = name.trim();
              if (trimmed === project.name || trimmed.length < 2) {
                setName(project.name);
                return;
              }
              try {
                await updateProject.mutateAsync({ projectId: project.id, name: trimmed });
                onSaved(project.key + ' is now called ' + trimmed + '.');
              } catch (error) {
                setName(project.name);
                onFailed(messageOf(error));
              }
            }}
          />
          <p className="mt-1 text-xs text-ink-faint">
            {teamName}
            {archived ? ' · archived' : ''}
          </p>
        </div>

        {canEdit ? (
          <>
            <Select
              aria-label={'Status of ' + project.key}
              value={project.status}
              disabled={archived}
              className="w-36"
              onChange={async (event) => {
                try {
                  await updateProject.mutateAsync({
                    projectId: project.id,
                    status: event.target.value as ProjectStatus,
                  });
                  onSaved(project.key + ' has been updated.');
                } catch (error) {
                  onFailed(messageOf(error));
                }
              }}
            >
              {PROJECT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status.charAt(0) + status.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>

            {archived ? (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await archiveProject.mutateAsync(project.id);
                    onSaved(project.key + ' is active again.');
                  } catch (error) {
                    onFailed(messageOf(error));
                  }
                }}
              >
                Restore
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="text-danger"
                onClick={() => archiving.ask(project)}
              >
                Archive
              </Button>
            )}
          </>
        ) : (
          <span className="self-center text-xs text-ink-faint">{teamName} leads this project</span>
        )}
      </div>

      <ConfirmDialog
        open={archiving.open}
        title={'Archive ' + project.key + '?'}
        description="Its tasks stay where they are and keep their keys, but the project stops appearing in pickers and on boards. You can restore it later."
        confirmLabel="Archive"
        busy={archiving.busy}
        error={archiving.error}
        onCancel={archiving.cancel}
        onConfirm={() => {
          void archiving.run(async (subject) => {
            await archiveProject.mutateAsync(subject.id);
            onSaved(subject.key + ' has been archived.');
          });
        }}
      />
    </Card>
  );
}
