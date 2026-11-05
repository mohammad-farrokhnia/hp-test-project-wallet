import { createHmac } from 'node:crypto';
import { WebhookVerifier } from './webhook-verifier';

const SECRET = 'hamtapay-sim-secret';
const sign = (raw: string, secret = SECRET) =>
  createHmac('sha256', secret).update(raw).digest('hex');

describe('WebhookVerifier', () => {
  const verifier = new WebhookVerifier(SECRET);
  const raw =
    '{"event":"transfer.updated","eventId":"evt_b798395f60412c18","requestId":"rq-c1a553d1-3f1f-4ff7-b144-626d6e42b192","trackingId":"TRK5028d818dee4cbbd","status":"PROCESSING","reason":null,"amount":"1000000","currency":"IRR","occurredAt":"2026-11-02T10:49:41.275Z"}';

  it('accepts the signature the real simulator sent for these bytes (evidence PAY-07)', () => {
    expect(
      verifier.verify(
        Buffer.from(raw),
        '2eb060a50f078366fa54b8fb88933b2931b575a35706e93488e7c2722585e437',
      ),
    ).toBe(true);
  });

  it('accepts the signature of exactly these bytes, in either hex case', () => {
    expect(verifier.verify(Buffer.from(raw), sign(raw))).toBe(true);
    expect(verifier.verify(Buffer.from(raw), sign(raw).toUpperCase())).toBe(
      true,
    );
  });

  it.each([
    ['no signature', undefined],
    ['an empty one', ''],
    ['one signed with another secret', sign(raw, 'not-the-secret')],
    ['a truncated one', sign(raw).slice(0, 63)],
    ['one with a non-hex character', `${sign(raw).slice(0, 63)}g`],
    ['one too long', `${sign(raw)}00`],
  ])('refuses %s', (_c, signature) => {
    expect(verifier.verify(Buffer.from(raw), signature)).toBe(false);
  });

  it('checks the raw bytes: the same JSON re-serialised is a different message', () => {
    const reserialised = JSON.stringify(JSON.parse(raw), null, 1);
    expect(verifier.verify(Buffer.from(reserialised), sign(raw))).toBe(false);
  });

  it('refuses a body changed by one byte (FAILED forged over PROCESSING)', () => {
    const forged = raw.replace('PROCESSING', 'FAILED');
    expect(verifier.verify(Buffer.from(forged), sign(raw))).toBe(false);
  });
});
