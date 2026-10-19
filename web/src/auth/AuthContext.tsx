import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from '../api/client';
import { useMe } from '../api/queries';
import type { Role, SessionUser, TeamMembership } from '../api/types';

interface AuthValue {
  user: SessionUser | null;
  teams: TeamMembership[];
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  roleIn: (teamId: number) => Role | null;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [hasToken, setHasToken] = useState(() => getToken() !== null);
  const me = useMe(hasToken);

  const logout = useCallback(() => {
    setToken(null);
    setHasToken(false);
    // drop everything cached so the next person never sees the previous user's data
    client.clear();
  }, [client]);

  // an expired or revoked token anywhere in the app sends the user back to login
  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await api<{ token: string }>('/api/auth/login', { method: 'POST', body: { email, password } });
      client.clear();
      setToken(result.token);
      setHasToken(true);
    },
    [client],
  );

  const value = useMemo<AuthValue>(() => {
    const teams = me.data?.teams ?? [];
    return {
      user: hasToken ? (me.data?.user ?? null) : null,
      teams,
      loading: hasToken && me.isPending,
      login,
      logout,
      roleIn: (teamId) => teams.find((team) => team.teamId === teamId)?.role ?? null,
    };
  }, [hasToken, me.data, me.isPending, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}