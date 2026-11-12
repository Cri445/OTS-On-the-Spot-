/** A failed API call, carrying the message the server wants the person to read. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (hasBody ? 'POST' : 'GET'),
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, "Can't reach OTS right now. Check your connection and try again.", 'network');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.message ?? 'Something went wrong. Please try again.', data?.error?.code ?? 'error');
  }
  return data as T;
}

export const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : 'Something went wrong. Please try again.');
