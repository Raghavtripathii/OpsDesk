const tokenKey = 'opsdesk.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(tokenKey);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(tokenKey, token);
    else localStorage.removeItem(tokenKey);
  } catch {
    // storage can be blocked; the session just won't survive a reload
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized: () => void = () => undefined;

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  // the item version the user saw; sent as If-Match
  version?: number;
  // one key per user action, reused when we retry after a network drop
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

const maxNetworkRetries = 2;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };

  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.version !== undefined) headers['If-Match'] = `"${options.version}"`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  // Retrying is only safe when the server can dedupe it, so reads and keyed writes only
  const canRetry = method === 'GET' || Boolean(options.idempotencyKey);

  let response: Response | null = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
      break;
    } catch (err) {
      if (options.signal?.aborted) throw err;
      if (!canRetry || attempt >= maxNetworkRetries) {
        throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection and try again.');
      }
      await sleep(400 * (attempt + 1));
    }
  }

  const text = await response.text();
  const payload: unknown = text ? safeParse(text) : null;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    if (response.status === 401 && path !== '/api/auth/login') onUnauthorized();
    throw new ApiError(
      response.status,
      error?.code ?? 'unknown_error',
      error?.message ?? `Request failed (${response.status})`,
      error?.details,
    );
  }

  return payload as T;
}