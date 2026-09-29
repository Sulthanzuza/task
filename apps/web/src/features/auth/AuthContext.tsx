import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthUser } from '@tm/shared';
import {
  api,
  cancelScheduledRefresh,
  restoreSession,
  setAccessToken,
  setAuthLostHandler,
} from '@/lib/api';

interface AuthState {
  user: AuthUser | null;
  /** True until the session restore on page load has finished. */
  loading: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  isLead: boolean;
  isAdmin: boolean;
  /** The team whose dashboard this user sees by default. */
  primaryTeamId: string | undefined;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // A reload has no access token in memory, only the refresh cookie; use it to
  // rebuild the session before the first screen renders.
  useEffect(() => {
    let cancelled = false;
    restoreSession()
      .then((session) => {
        if (!cancelled) setUser(session?.user ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // When a refresh finally fails, drop the user so the router sends them to login.
  useEffect(() => {
    setAuthLostHandler(() => setUser(null));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const response = await api.login(email, password);
    setAccessToken(response.accessToken, response.expiresInSeconds);
    setUser(response.user);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      // Nothing left to keep alive.
      cancelScheduledRefresh();
      setAccessToken(null);
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      signIn,
      signOut,
      isLead: user?.role === 'TEAM_LEAD' || user?.role === 'SUPER_ADMIN',
      isAdmin: user?.role === 'SUPER_ADMIN',
      primaryTeamId: user?.ledTeamIds[0] ?? user?.teamIds[0],
    }),
    [user, loading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}

/** The signed-in user, for screens that only render behind a route guard. */
export function useCurrentUser(): AuthUser {
  const { user } = useAuth();
  if (!user) throw new Error('This screen requires a signed-in user');
  return user;
}
