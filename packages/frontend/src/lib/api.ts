const API_BASE = import.meta.env.VITE_API_URL || '/api';

// No request may hang forever. On a flaky link an operator once opened a shift
// and watched the button grey out for the rest of the day: `fetch` has no
// timeout of its own, so a stalled connection left the submit flag set and the
// `finally` that clears it never ran. An unanswered request now becomes a
// sentence she can act on instead of a button that never comes back.
//
// Sixty seconds, far past anything the JSON endpoints take. The genuinely slow
// calls — CSV exports and backup downloads — never come through here: they use
// fetch directly and stream a file to disk, so this cannot cut one of those
// short. The parameter is per-call for the day a query does need longer.
const DEFAULT_TIMEOUT_MS = 60_000;

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const token = localStorage.getItem('accessToken');
  const isFormData = options.body instanceof FormData;
  const headers: Record<string, string> = isFormData
    ? { ...(options.headers as Record<string, string>) }
    : { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // The signal covers the body read as well as the response headers: a payload
  // that stops arriving half way is the same fault as one that never starts.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'Request failed');
    }

    return data.data;
  } catch (err) {
    // An abort here is this timeout firing — nobody cancelled anything — and
    // the browser's own wording for it ("The user aborted a request.") reads
    // as though the operator did something wrong.
    if (controller.signal.aborted) {
      throw new Error(
        `The server did not answer within ${Math.round(timeoutMs / 1000)} seconds. Check the connection and try again.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function unwrapRows<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const nested = (value as { data?: unknown } | null | undefined)?.data;
  return Array.isArray(nested) ? nested as T[] : [];
}

export const api = {
  get: <T>(path: string, timeoutMs?: number) => request<T>(path, {}, timeoutMs),
  post: <T>(path: string, body?: any, isFormData = false, timeoutMs?: number) => request<T>(path, {
    method: 'POST',
    body: isFormData ? body : body ? JSON.stringify(body) : undefined,
  }, timeoutMs),
  put: <T>(path: string, body: any, timeoutMs?: number) => request<T>(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, timeoutMs),
  patch: <T>(path: string, body: any, timeoutMs?: number) => request<T>(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }, timeoutMs),
  delete: <T>(path: string, timeoutMs?: number) => request<T>(path, { method: 'DELETE' }, timeoutMs),
};
