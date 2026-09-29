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
import { TeamPage } from '@/features/team/TeamPage';
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
              action={
                <Button onClick={() => window.location.reload()}>Reload the page</Button>
              }
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
          <Route path="/team" element={<TeamPage />} />
          <Route path="/team/:userId" element={<MemberPage />} />

          <Route path="/board" element={<BoardPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route
            path="/workload"
            element={
              <RequireLead>
                <Placeholder title="Workload" note="Capacity-aware workload arrives with the leave and holidays work." />
              </RequireLead>
            }
          />
          <Route
            path="/reports"
            element={
              <RequireLead>
                <Placeholder title="Reports" note="Reports arrive with the search and reporting work." />
              </RequireLead>
            }
          />
          <Route
            path="/settings"
            element={<Placeholder title="Settings" note="Notification preferences and org settings arrive with the notifications work." />}
          />
        </Route>

        <Route
          path="*"
          element={<Placeholder title="Page not found" note="That address does not match a screen." />}
        />
      </Routes>
    </ErrorBoundary>
  );
}
