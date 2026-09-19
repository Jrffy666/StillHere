export async function api<T>(
  path: string,
  token?: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(25_000),
  });
  const value = await response
    .json()
    .catch(() => ({ error: 'The service returned an unreadable response.' }));
  if (!response.ok) {
    throw new Error(
      responseError(value, `Request failed (${response.status}).`),
    );
  }
  return value as T;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
}
export function responseError(value: unknown, fallback: string): string {
  if (typeof value !== 'object' || value === null) return fallback;
  if ('error' in value) {
    if (typeof value.error === 'string') return value.error;
    if (
      typeof value.error === 'object' &&
      value.error !== null &&
      'message' in value.error &&
      typeof value.error.message === 'string'
    )
      return value.error.message;
  }
  return 'message' in value && typeof value.message === 'string'
    ? value.message
    : fallback;
}
export function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}
