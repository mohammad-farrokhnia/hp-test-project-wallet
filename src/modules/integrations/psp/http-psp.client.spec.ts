import { Logger } from '@nestjs/common';
import { Money } from '../../../common/money';
import { HttpPspClient } from './http-psp.client';
import { FakePspServer, PspCreateFault } from './testing/fake-psp-server';

const CALLBACK = 'http://app:3000/webhooks/psp/callback/dep-1';

describe('HttpPspClient against a scripted PSP', () => {
  const psp = new FakePspServer();
  let client: HttpPspClient;
  let fault: PspCreateFault = 'ok';
  const verify503 = new Set<string>();

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    psp.script = {
      onCreate: () => fault,
      verify503: (token, attempt) => attempt === 1 && verify503.has(token),
    };
    client = new HttpPspClient(await psp.start(), 300);
  });

  afterAll(async () => {
    await psp.stop();
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    fault = 'ok';
    verify503.clear();
  });

  const create = async (amount = 1_000_000n) => {
    const o = await client.createPayment(Money.rial(amount), 'dep-1', CALLBACK);
    if (o.kind !== 'CREATED') throw new Error(`create gave ${o.kind}`);
    return o;
  };

  describe('createPayment', () => {
    it('sends rial as an integer string with the orderId and callbackUrl (PSP-01, PSP-02)', async () => {
      const { token } = await create(1_000_000n);
      expect(psp.payments.get(token)).toMatchObject({
        amount: '1000000',
        orderId: 'dep-1',
        callbackUrl: CALLBACK,
      });
    });

    it('returns the token and payment link', async () => {
      const o = await create();
      expect(o.token).toMatch(/^A0/);
      expect(o.paymentUrl).toContain(`/psp/pay/${o.token}`);
    });

    it('makes a new token on every call: orderId is not de-duplicated (PSP-03)', async () => {
      const a = await create();
      const b = await create();
      expect(a.token).not.toBe(b.token);
    });

    it('400 → REJECTED with the PSP code', async () => {
      fault = 'reject';
      await expect(
        client.createPayment(Money.rial(5n), 'dep-1', CALLBACK),
      ).resolves.toMatchObject({ kind: 'REJECTED', code: -12 });
    });

    it.each(['503', 'timeout', 'reset'] as const)(
      '%s → UNAVAILABLE, never REJECTED',
      async (f) => {
        fault = f;
        const o = await client.createPayment(
          Money.rial(1_000_000n),
          'dep-1',
          CALLBACK,
        );
        expect(o.kind).toBe('UNAVAILABLE');
      },
    );

    it('reports a timeout as such', async () => {
      fault = 'timeout';
      await expect(
        client.createPayment(Money.rial(1_000_000n), 'dep-1', CALLBACK),
      ).resolves.toEqual({ kind: 'UNAVAILABLE', reason: 'timeout' });
    });
  });

  describe('getPayment', () => {
    it('follows the payment: INIT, then PAID with a refId', async () => {
      const { token } = await create();
      await expect(client.getPayment(token)).resolves.toMatchObject({
        kind: 'FOUND',
        status: 'INIT',
        refId: null,
        amount: Money.rial(1_000_000n),
      });
      psp.pay(token);
      await expect(client.getPayment(token)).resolves.toMatchObject({
        kind: 'FOUND',
        status: 'PAID',
        refId: expect.any(String) as string,
      });
    });

    it('an unknown token → NOT_FOUND', async () => {
      await expect(client.getPayment('A0nope')).resolves.toEqual({
        kind: 'NOT_FOUND',
      });
    });
  });

  describe('verify', () => {
    it('100 the first time, then 101 with the same refId (PSP-08)', async () => {
      const { token } = await create();
      psp.pay(token);
      const first = await client.verify(token);
      const again = await client.verify(token);
      expect(first).toMatchObject({
        kind: 'OK',
        amount: Money.rial(1_000_000n),
      });
      expect(again).toMatchObject({ kind: 'ALREADY_VERIFIED' });
      expect(again.kind === 'ALREADY_VERIFIED' && again.refId).toBe(
        first.kind === 'OK' && first.refId,
      );
    });

    it('-51 for a payment still INIT: NOT_PAID, which is not a failure (PSP-08)', async () => {
      const { token } = await create();
      await expect(client.verify(token)).resolves.toEqual({ kind: 'NOT_PAID' });
      expect(psp.payments.get(token)?.status).toBe('INIT');
    });

    it('a 503 is UNAVAILABLE and not applied: the next verify is 100, not 101 (PSP-09)', async () => {
      const { token } = await create();
      psp.pay(token);
      verify503.add(token);
      await expect(client.verify(token)).resolves.toMatchObject({
        kind: 'UNAVAILABLE',
      });
      await expect(client.verify(token)).resolves.toMatchObject({ kind: 'OK' });
    });

    it('an unknown token → NOT_FOUND', async () => {
      await expect(client.verify('A0nope')).resolves.toEqual({
        kind: 'NOT_FOUND',
      });
    });

    it('a PSP that is down → UNAVAILABLE', async () => {
      const down = new HttpPspClient('http://127.0.0.1:1', 300);
      await expect(down.verify('A0x')).resolves.toMatchObject({
        kind: 'UNAVAILABLE',
      });
    });
  });

  describe('getSettlement (PSP-12)', () => {
    beforeEach(() => {
      psp.settlementFault = 'ok';
      psp.settlementFiles.clear();
      psp.settlementDays.length = 0;
    });

    it('asks for the Tehran day it was given and returns the file as text', async () => {
      psp.setSettlement('2026-11-05', 'h1,h2\r\n1,2\r\n');
      await expect(client.getSettlement('2026-11-05')).resolves.toEqual({
        kind: 'FOUND',
        csv: 'h1,h2\r\n1,2\r\n',
      });
      expect(psp.settlementDays).toEqual(['2026-11-05']);
    });

    it('a day with nothing registered is the empty file, still FOUND', async () => {
      const o = await client.getSettlement('2026-01-01');
      expect(o.kind).toBe('FOUND');
    });

    it.each(['503', 'json', 'empty'] as const)(
      'a PSP that answers %s has no file → UNAVAILABLE',
      async (fault) => {
        psp.settlementFault = fault;
        await expect(client.getSettlement('2026-11-05')).resolves.toMatchObject(
          {
            kind: 'UNAVAILABLE',
          },
        );
      },
    );

    it('a proxy error page served with a 200 is text, so it is FOUND here: the settlement parser refuses it', async () => {
      psp.settlementFault = 'html';
      await expect(client.getSettlement('2026-11-05')).resolves.toMatchObject({
        kind: 'FOUND',
      });
    });

    it('a PSP that is down → UNAVAILABLE', async () => {
      const down = new HttpPspClient('http://127.0.0.1:1', 300);
      await expect(down.getSettlement('2026-11-05')).resolves.toMatchObject({
        kind: 'UNAVAILABLE',
      });
    });
  });
});
