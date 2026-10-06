import { useQuery } from '@tanstack/react-query';
import type { AuthOptions } from '@tm/shared';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Whether this deployment sends email. Public, so the forgot-password page
 * can ask before anyone is signed in, and it changes only with a redeploy.
 */
export function useAuthOptions() {
  return useQuery({
    queryKey: queryKeys.auth.options(),
    queryFn: ({ signal }) => api.get<AuthOptions>('/auth/options', signal),
    staleTime: Infinity,
  });
}
