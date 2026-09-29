import type { ApiErrorBody, LoginResponse } from '@tm/shared';

/**
 * The single way the app talks to the server.
 *
 * The access token lives in memory only: a page reload recovers the session from the
 * httpOnly refresh cookie instead. That way nothing usable is left in localStorage
 * for a cross-site script to steal.
 */

const BASE = '/api/v1';

let accessToken: string | null = null;
/** When the current token stops being accepted, as an epoch milliseconds value. */
let accessTokenExpiresAt = 0;
let onAuthLost: (() => void) | null = null;

export function setAccessToken(token: string | null, expiresInSeconds?: number): void {
  accessToken = token;
  accessTokenExpiresAt =
    token && expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : token ? Number.MAX_SAFE_INTEGER : 0;
}

/**
 * Is the token too close to expiry to be worth sending?
 * The margin covers the request's time in flight, so a token that would die
 * mid-journey is replaced before it is used rather than after it fails.
 */
function tokenAboutToExpire(): boolean {
  return accessToken !== null && Date.now() >= accessTokenExpiresAt - 1000;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAuthLostHandler(handler: () => void): void {
  onAuthLost = handler;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error.message ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error.code ?? 'UNKNOWN';
    this.details = body?.error.details;
  }

  /** Field-level messages, for putting errors next to the input that caused them. */
  fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const item of this.details) {
        if (
          typeof item === 'object' &&
          item !== null &&
          'path' in item &&
          'message' in item &&
          typeof item.path === 'string'
        ) {
          result[item.path] = String(item.message);
        }
      }
    }
    return result;
  }
}

/**
 * Refreshing rotates the token on the server, and presenting a rotated token again
 * is treated as theft: every session for that user is revoked. So two refreshes
 * must never be in flight at once.
 *
 * Every caller — a 401 retry, a session restore, two components mounting together,
 * React's double-invoked effects in development — shares this one promise.
 */
let inFlightRefresh: Promise<LoginResponse | null> | null = null;

/**
 * Refresh shortly before the token expires, rather than waiting for a request to
 * fail and retrying it. Reacting to a 401 works, but it costs every user one
 * failed request each time the token runs out.
 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export function cancelScheduledRefresh(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefresh(expiresInSeconds: number): void {
  cancelScheduledRefresh();
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return;

  // Leave a margin for a slow network, but never more than a quarter of a short
  // lifetime, or a brief token would schedule a refresh in the past.
  const margin = Math.min(30, Math.max(1, expiresInSeconds / 4));
  const delayMs = Math.max(500, (expiresInSeconds - margin) * 1000);

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void performRefresh();
  }, delayMs);
}

/** The one network call. Everything else exists to make sure only one runs at a time. */
async function sendRefresh(): Promise<LoginResponse | null> {
  try {
    const response = await fetch(BASE + '/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as LoginResponse;
    accessToken = body.accessToken;
    return body;
  } catch {
    return null;
  }
}

/**
 * Serialise refreshes across tabs as well as within one.
 *
 * The in-flight promise only covers this tab. Two tabs waking together would each
 * present the same cookie, and the second would look like a replay. A Web Lock is
 * held across the whole origin, so only one tab refreshes at a time and the others
 * run afterwards, by which point the cookie jar holds the successor.
 *
 * Not every browser has the Locks API; without it we fall back to the per-tab
 * guard, and the server's grace window covers the rest.
 */
async function withRefreshLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return run();
  return locks.request('tm-refresh', run);
}

function performRefresh(): Promise<LoginResponse | null> {
  inFlightRefresh ??= (async () => {
    try {
      return await withRefreshLock(async () => {
        // The cookie is read by the browser when the request goes out, not when
        // we queued for the lock. A tab that waited here therefore presents
        // whatever the winning tab left behind, which is the successor.
        const first = await sendRefresh();
        if (first) return first;

        // It failed anyway. If a session cookie is still present, the most likely
        // cause is that our token was superseded between the attempt and now, so
        // try once more with what the jar holds. A genuinely dead session fails
        // both times and the user is sent to sign in.
        return hasSessionHint() ? sendRefresh() : null;
      });
    } finally {
      // Release on the next tick, so waiters read the new token first.
      queueMicrotask(() => {
        inFlightRefresh = null;
      });
    }
  })();

  return inFlightRefresh;
}

async function refreshOnce(): Promise<boolean> {
  return (await performRefresh()) !== null;
}

/**
 * The API sets a readable tm_session flag next to the httpOnly refresh cookie.
 * Checking it first means an anonymous visitor never fires a refresh request
 * just to be told 401.
 */
export function hasSessionHint(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split(';').some((part) => part.trim().startsWith('tm_session='));
}

export async function restoreSession(): Promise<LoginResponse | null> {
  if (!hasSessionHint()) return null;
  return performRefresh();
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Set for the login call, which has no token yet and must not trigger a refresh. */
  skipAuth?: boolean;
}

async function send(path: string, options: RequestOptions, isRetry: boolean): Promise<Response> {
  // Replace a token that is already spent before spending a round trip on it.
  if (!options.skipAuth && !isRetry && tokenAboutToExpire()) {
    await performRefresh();
  }

  const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken && !options.skipAuth) headers.Authorization = 'Bearer ' + accessToken;

  const response = await fetch(BASE + path, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  // One refresh attempt per request; a second 401 means the session is really gone.
  if (response.status === 401 && !isRetry && !options.skipAuth) {
    const refreshed = await refreshOnce();
    if (refreshed) return send(path, options, true);
    accessToken = null;
    accessTokenExpiresAt = 0;
    cancelScheduledRefresh();
    onAuthLost?.();
  }

  return response;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options, false);

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // A non-JSON error body (a proxy error page, say) still becomes an ApiError.
    }
    throw new ApiError(response.status, body, 'The request failed (' + response.status + ').');
  }

  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
  /** Login has no token yet and must not be retried through refresh. */
  login: async (email: string, password: string) => {
    const response = await apiRequest<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      skipAuth: true,
    });
    scheduleRefresh(response.expiresInSeconds);
    return response;
  },
};

/** Turns a filter object into a query string, dropping empty values. */
export function toQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? '?' + query : '';
}
