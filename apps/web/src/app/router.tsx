import { Component, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './Layout';
import { useAuth } from '@/features/auth/AuthContext';
import { LoginPage } from '@/features/auth/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage } from '@/features/auth/PasswordPages';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { TasksPage } from '@/features/tasks/TasksPage';
import { TaskDetailPage } from '@/features/tasks/TaskDetailPage';
import { MyTasksPage } from '@/features/tasks/MyTasksPage';
import { MemberPage } from '@/features/team/MemberPage';
import { BoardPage } from '@/features/board/BoardPage';
import { CalendarPage } from '@/features/calendar/CalendarPage';
import { NotificationsPage } from '@/features/notifications/NotificationsPage';
import { DigestPage } from '@/features/digest/DigestPage';
import { NotificationPreferencesPage } from '@/features/notifications/PreferencesPage';
import { TeamPage } from '@/features/team/TeamPage';
import { PeoplePage } from '@/features/admin/PeoplePage';
import { TeamsPage } from '@/features/admin/TeamsPage';
import { ProjectsPage } from '@/features/admin/ProjectsPage';
import { OrganisationPage } from '@/features/admin/OrganisationPage';
import { HolidaysPage } from '@/features/admin/HolidaysPage';
import { EmailPage } from '@/features/admin/EmailPage';
import { ImportPage } from '@/features/admin/ImportPage';
import { AuditPage } from '@/features/admin/AuditPage';
import { DesignPage } from '@/features/design/DesignPage';
import { Button, Card, EmptyState, Spinner } from '@/components/ui/primitives';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-accent" />
      </div>
    );
  }

  // Remember where they were headed, so signing in lands them there.
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;

  return <>{children}</>;
}

function RequireLead({ children }: { children: ReactNode }) {
  const { isLead } = useAuth();
  if (!isLead) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Card>
          <EmptyState
            title="This screen is for team leads"
            description="Your own tasks and figures are on My tasks and your member page."
          />
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * The administrator's screens.
 *
 * The server refuses these routes to anyone else, so this is only about not
 * showing a person a screen that would fail; it is not the access control.
 */
function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth();
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Card>
          <EmptyState
            title="This screen is for administrators"
            description="Ask a super admin if you need somebody invited, or a setting changed."
          />
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}

/** A crash in one screen must not take the whole app down with it. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-lg px-4 py-16">
          <Card>
            <EmptyState
              title="Something broke on this screen"
              description={this.state.error.message}
              action={<Button onClick={() => window.location.reload()}>Reload the page</Button>}
            />
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <Card>
        <EmptyState title={title} description={note} />
      </Card>
    </div>
  );
}

/** Sends people to the screen that suits their role. */
function HomeRedirect() {
  const { isLead } = useAuth();
  return <Navigate to={isLead ? '/dashboard' : '/my-tasks'} replace />;
}

export function AppRoutes() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />

        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<HomeRedirect />} />
          <Route
            path="/dashboard"
            element={
              <RequireLead>
                <DashboardPage />
              </RequireLead>
            }
          />
          <Route path="/my-tasks" element={<MyTasksPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:key" element={<TaskDetailPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/digest/:date" element={<DigestPage />} />
          <Route path="/settings/notifications" element={<NotificationPreferencesPage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/team/:userId" element={<MemberPage />} />

          <Route path="/board" element={<BoardPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route
            path="/workload"
            element={
              <RequireLead>
                <Placeholder
                  title="Workload"
                  note="Capacity-aware workload arrives with the leave and holidays work."
                />
              </RequireLead>
            }
          />
          <Route
            path="/reports"
            element={
              <RequireLead>
                <Placeholder
                  title="Reports"
                  note="Reports arrive with the search and reporting work."
                />
              </RequireLead>
            }
          />
          {/*
            The design system, for judging a palette change against all four
            themes at once. import.meta.env.DEV is statically false in a
            production build, so the page and its charts are tree-shaken out.
          */}
          {import.meta.env.DEV ? <Route path="/design" element={<DesignPage />} /> : null}

          <Route path="/settings" element={<Navigate to="/settings/notifications" replace />} />

          <Route path="/admin" element={<Navigate to="/admin/people" replace />} />
          <Route
            path="/admin/people"
            element={
              <RequireAdmin>
                <PeoplePage />
              </RequireAdmin>
            }
          />
          <Route
            path="/admin/teams"
            element={
              <RequireAdmin>
                <TeamsPage />
              </RequireAdmin>
            }
          />
          {/* A lead runs their own team's projects, so these two are not admin-only. */}
          <Route
            path="/admin/projects"
            element={
              <RequireLead>
                <ProjectsPage />
              </RequireLead>
            }
          />
          <Route
            path="/admin/import"
            element={
              <RequireLead>
                <ImportPage />
              </RequireLead>
            }
          />
          <Route
            path="/admin/audit"
            element={
              <RequireAdmin>
                <AuditPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/settings/organisation"
            element={
              <RequireAdmin>
                <OrganisationPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/settings/holidays"
            element={
              <RequireAdmin>
                <HolidaysPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/settings/email"
            element={
              <RequireAdmin>
                <EmailPage />
              </RequireAdmin>
            }
          />
        </Route>

        <Route
          path="*"
          element={
            <Placeholder title="Page not found" note="That address does not match a screen." />
          }
        />
      </Routes>
    </ErrorBoundary>
  );
}
