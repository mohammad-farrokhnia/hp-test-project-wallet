/** What a provider answered: the HTTP status and the parsed body. */
export interface HttpAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * @function callJson
 * @description One provider call with a timeout. Node's `fetch` keeps connections alive.
 * An unreadable body is returned as raw text: it is evidence too.
 * @param baseUrl - the provider's base URL
 * @param timeoutMs - abort the call after this long
 * @param method - `GET` or `POST`
 * @param path - the path under `baseUrl`
 * @param body - JSON body for a POST
 * @returns the status and body
 * @throws on timeout, connection reset or any transport failure: callers classify these as ambiguous
 */
export async function callJson(
  baseUrl: string,
  timeoutMs: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<HttpAnswer> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/**
 * @function describeFailure
 * @description A short reason for a transport failure, by shape rather than `instanceof`: fetch's errors may come from another realm.
 * @param err - whatever `callJson` threw
 * @returns `timeout`, the socket error code, or a message
 */
export function describeFailure(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'unknown error';
  const e = err as {
    name?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout';
  return e.cause?.code ?? e.cause?.message ?? e.message ?? 'unknown error';
}
