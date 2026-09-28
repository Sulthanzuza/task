import { Link } from 'react-router-dom';
import { useTeams } from './api';
import { Card, EmptyState, Skeleton } from '@/components/ui/primitives';
import { UserAvatar } from '@/components/common/badges';
import { ROLE_LABELS } from '@tm/shared';

export function TeamPage() {
  const teams = useTeams();

  if (teams.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-3 px-4 py-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
      <h1 className="text-xl font-semibold tracking-tight">Team</h1>

      {teams.data?.items.length ? (
        teams.data.items.map((team) => (
          <section key={team.id} aria-labelledby={'team-' + team.id}>
            <h2 id={'team-' + team.id} className="mb-2 text-sm font-semibold">
              {team.name}
              {team.lead ? (
                <span className="ml-2 font-normal text-ink-faint">led by {team.lead.name}</span>
              ) : null}
            </h2>
            <Card>
              <ul className="divide-y divide-border-subtle">
                {team.members.map((member) => (
                  <li key={member.id}>
                    <Link
                      to={'/team/' + member.id}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-muted"
                    >
                      <UserAvatar user={member} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{member.name}</p>
                        <p className="truncate text-xs text-ink-faint">{member.email}</p>
                      </div>
                      <span className="shrink-0 text-xs text-ink-muted">
                        {ROLE_LABELS[member.role]}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        ))
      ) : (
        <Card>
          <EmptyState title="You are not on a team yet" description="Ask an admin to add you." />
        </Card>
      )}
    </div>
  );
}
