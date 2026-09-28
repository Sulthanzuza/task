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
let onAuthLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
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
 * Concurrent 401s must not each fire their own refresh, or the rotation would
 * invalidate itself and log the user out. They all wait on the same promise.
 */
let inFlightRefresh: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  inFlightRefresh ??= (async () => {
    try {
      const response = await fetch(BASE + '/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!response.ok) return false;
      const body = (await response.json()) as LoginResponse;
      accessToken = body.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Release the lock on the next tick, so waiters read the new token first.
      queueMicrotask(() => {
        inFlightRefresh = null;
      });
    }
  })();

  return inFlightRefresh;
}

export async function restoreSession(): Promise<LoginResponse | null> {
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

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Set for the login call, which has no token yet and must not trigger a refresh. */
  skipAuth?: boolean;
}

async function send(path: string, options: RequestOptions, isRetry: boolean): Promise<Response> {
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
  login: (email: string, password: string) =>
    apiRequest<LoginResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      skipAuth: true,
    }),
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
