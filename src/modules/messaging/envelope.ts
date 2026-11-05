/** What travels on the wire: ids only, so handlers reload state from the database. */
export interface Envelope {
  readonly messageId: string;
  /** The job or event name, e.g. `job.withdrawal.sync`. */
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, string>>;
}

const FIELDS = [
  'messageId',
  'type',
  'aggregateType',
  'aggregateId',
  'occurredAt',
] as const;

/**
 * @function parseEnvelope
 * @description Reads a message body. Anything that is not a well-formed envelope is `null`:
 *  a poison message no retry can fix.
 * @param content - the raw message body
 * @returns the envelope, or `null`
 */
export function parseEnvelope(content: Buffer): Envelope | null {
  let value: unknown;
  try {
    value = JSON.parse(content.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  for (const f of FIELDS) {
    if (typeof v[f] !== 'string' || v[f] === '') return null;
  }
  const payload = v.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  if (!Object.values(payload).every((x) => typeof x === 'string')) return null;
  return v as unknown as Envelope;
}
