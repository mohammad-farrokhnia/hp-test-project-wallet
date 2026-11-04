import { createHash } from 'node:crypto';

/**
 * @function canonicalJson
 * @description JSON with object keys sorted at every depth, so two bodies that differ only in key order serialise the same. `undefined` object values are dropped.
 * @param value - a parsed JSON body
 * @returns the canonical text
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * @function fingerprint
 * @description sha256 of the scope and the canonical body. The scope is included because keys are global: the same key on another route is a reuse.
 * @param scope - the route, e.g. `POST /withdrawals`
 * @param body - the parsed request body
 * @returns lowercase hex digest
 */
export function fingerprint(scope: string, body: unknown): string {
  return createHash('sha256')
    .update(scope)
    .update('\n')
    .update(canonicalJson(body))
    .digest('hex');
}
