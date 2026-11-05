import { Logger } from '@nestjs/common';
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { Money } from '../../../common/money';
import { HttpPayoutClient } from './http-payout.client';
import { PayoutRequest } from './payout.port';

type Handler = (
  req: IncomingMessage,
  body: string,
  res: ServerResponse,
) => void;

/** A payout service scripted per finding id; records what it was sent. */
describe('HttpPayoutClient against a scripted payout service', () => {
  let server: Server;
  let baseUrl: string;
  let handler: Handler;
  const received: { method: string; url: string; body: unknown }[] = [];

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: body ? (JSON.parse(body) as unknown) : null,
        });
        handler(req, body, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    received.length = 0;
  });

  const client = new (class {
    get c() {
      return new HttpPayoutClient(baseUrl, 300);
    }
  })();
  const json =
    (status: number, body: unknown): Handler =>
    (_q, _b, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

  const irr: PayoutRequest = {
    requestId: '0193a5b0-0000-7000-8000-000000000001',
    destinationType: 'IBAN',
    destination: 'IR330566736841214070501510',
    amount: Money.rial(1_000_000n),
  };
  const transfer = (over: Record<string, unknown> = {}) => ({
    requestId: irr.requestId,
    trackingId: 'TRK1751cf07084bc1b0',
    status: 'ACCEPTED',
    reason: null,
    amount: '1000000',
    currency: 'IRR',
    destination: irr.destination,
    updatedAt: '2026-11-02T10:48:09.134Z',
    ...over,
  });

  describe('request shape (PAY-01)', () => {
    it('sends IRR as an integer rial string to /payout/transfers', async () => {
      handler = json(202, transfer());
      await client.c.submit(irr);
      expect(received[0]).toEqual({
        method: 'POST',
        url: '/payout/transfers',
        body: {
          requestId: irr.requestId,
          type: 'IBAN',
          destination: irr.destination,
          amount: '1000000',
          currency: 'IRR',
        },
      });
    });

    it('sends USDT as a decimal string with type CRYPTO', async () => {
      handler = json(202, transfer({ currency: 'USDT', amount: '10.5' }));
      await client.c.submit({
        ...irr,
        destinationType: 'TRC20',
        destination: 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bP',
        amount: Money.microUsdt(10_500_000n),
      });
      expect(received[0].body).toMatchObject({
        type: 'CRYPTO',
        amount: '10.5',
        currency: 'USDT',
      });
    });
  });

  describe('submit outcomes', () => {
    it('202 → ACCEPTED with the snapshot', async () => {
      handler = json(202, transfer());
      const o = await client.c.submit(irr);
      expect(o).toMatchObject({ kind: 'ACCEPTED', httpStatus: 202 });
      expect(o.kind === 'ACCEPTED' && o.snapshot).toMatchObject({
        status: 'ACCEPTED',
        trackingId: 'TRK1751cf07084bc1b0',
      });
    });

    it('200 → REPLAYED with no mismatch when the existing transfer is ours (PAY-02)', async () => {
      handler = json(200, transfer());
      const o = await client.c.submit(irr);
      expect(o).toMatchObject({
        kind: 'REPLAYED',
        httpStatus: 200,
        mismatches: [],
      });
    });

    it('200 with the ORIGINAL amount after we sent another → REPLAYED, amount flagged (PAY-02)', async () => {
      handler = json(200, transfer({ amount: '2000000' }));
      const o = await client.c.submit(irr);
      expect(o).toMatchObject({ kind: 'REPLAYED', mismatches: ['amount'] });
    });

    it('200 for another destination or currency → both flagged', async () => {
      handler = json(
        200,
        transfer({
          destination: 'IR062960000000100324200001',
          currency: 'USDT',
          amount: '1',
        }),
      );
      const o = await client.c.submit(irr);
      expect(o).toMatchObject({
        kind: 'REPLAYED',
        mismatches: ['currency', 'destination'],
      });
    });

    it('400 → REJECTED with the provider error code', async () => {
      handler = json(400, {
        error: 'INVALID_AMOUNT',
        message: 'amount must be positive',
      });
      const o = await client.c.submit(irr);
      expect(o).toMatchObject({
        kind: 'REJECTED',
        error: 'INVALID_AMOUNT',
        httpStatus: 400,
      });
    });

    it('503 → AMBIGUOUS: it may have been created (PAY-03)', async () => {
      handler = json(503, { error: 'UPSTREAM_UNAVAILABLE' });
      const o = await client.c.submit(irr);
      expect(o).toMatchObject({
        kind: 'AMBIGUOUS',
        reason: 'UPSTREAM_UNAVAILABLE',
        httpStatus: 503,
      });
    });

    it('no answer within the timeout → AMBIGUOUS timeout (PAY-04)', async () => {
      handler = () => undefined; // never answers
      const o = await client.c.submit(irr);
      expect(o).toMatchObject({
        kind: 'AMBIGUOUS',
        reason: 'timeout',
        httpStatus: null,
        error: 'timeout',
      });
    });

    it('connection reset → AMBIGUOUS (PAY-04)', async () => {
      handler = (req) => req.socket.destroy();
      const o = await client.c.submit(irr);
      expect(o).toMatchObject({ kind: 'AMBIGUOUS', httpStatus: null });
      expect(o.kind === 'AMBIGUOUS' && o.reason).toMatch(
        /ECONNRESET|socket|terminated|closed/i,
      );
    });

    it('an unreadable 202 → AMBIGUOUS, never ACCEPTED or FAILED', async () => {
      handler = (_q, _b, res) => {
        res.writeHead(202);
        res.end('<html>gateway</html>');
      };
      const o = await client.c.submit(irr);
      expect(o).toMatchObject({
        kind: 'AMBIGUOUS',
        httpStatus: 202,
        responseBody: '<html>gateway</html>',
      });
    });

    it.each([401, 404, 409, 500, 502])(
      '%s → AMBIGUOUS, not REJECTED',
      async (status) => {
        handler = json(status, { error: 'X' });
        expect((await client.c.submit(irr)).kind).toBe('AMBIGUOUS');
      },
    );
  });

  describe('getTransfer outcomes', () => {
    it('200 → FOUND with the snapshot', async () => {
      handler = json(200, transfer({ status: 'SUCCEEDED' }));
      const o = await client.c.getTransfer(irr.requestId);
      expect(received[0]).toMatchObject({
        method: 'GET',
        url: `/payout/transfers/${irr.requestId}`,
      });
      expect(o).toMatchObject({
        kind: 'FOUND',
        snapshot: { status: 'SUCCEEDED' },
      });
    });

    it('404 → NOT_FOUND', async () => {
      handler = json(404, { error: 'NOT_FOUND' });
      expect(await client.c.getTransfer(irr.requestId)).toEqual({
        kind: 'NOT_FOUND',
      });
    });

    it.each([
      ['503', json(503, { error: 'UPSTREAM_UNAVAILABLE' })],
      ['a timeout', () => undefined],
      ['an unreadable 200', json(200, { hello: 'world' })],
    ])('%s → UNAVAILABLE', async (_c, h) => {
      handler = h;
      expect((await client.c.getTransfer(irr.requestId)).kind).toBe(
        'UNAVAILABLE',
      );
    });
  });
});
