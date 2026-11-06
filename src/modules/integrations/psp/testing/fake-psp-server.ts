import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { randomBytes } from 'node:crypto';
import { AddressInfo, Socket } from 'node:net';
import type { PspStatus } from '../psp.port';
import { SETTLEMENT_HEADER } from '../settlement-csv';

/**
 * How the fake answers one create (POST /psp/payments):
 * - `ok`: 201 with a new token, every time (PSP-03: `orderId` is never de-duplicated);
 * - `reject`: 400 `-12`, nothing created;
 * - `503`: 503, nothing created;
 * - `timeout`: never answers, nothing created;
 * - `reset`: resets the connection, nothing created.
 */
export type PspCreateFault = 'ok' | 'reject' | '503' | 'timeout' | 'reset';

export interface FakePayment {
  readonly token: string;
  readonly orderId: string;
  readonly amount: string;
  readonly callbackUrl: string;
  status: PspStatus;
  refId: string | null;
}

/**
 * How the fake answers `GET /psp/settlement`:
 * - `ok`: the file registered for the day with `setSettlement`, or a header-only file;
 * - `503`: 503;
 * - `html`: 200 with an HTML page (a proxy's error page);
 * - `json`: 200 with a JSON error object;
 * - `empty`: 200 with nothing;
 * - `reset`: resets the connection.
 */
export type SettlementFault =
  'ok' | '503' | 'html' | 'json' | 'empty' | 'reset';

export interface PspScript {
  onCreate(attempt: number): PspCreateFault;
  verify503(token: string, attempt: number): boolean;
}

/**
 * @class FakePspServer
 * @description A stateful PSP for deposit tests, behaving as probed: unique random tokens, unsigned, no `orderId` de-duplication,
 * verify answers 100 once then 101 with the same `refId` (a 10-digit bank reference, like the PSP's) and `-51` for anything not paid, and a 503 verify is not applied.
 * `pay` stands in for the payer on the payment page.
 */
export class FakePspServer {
  readonly payments = new Map<string, FakePayment>();
  readonly settlementFiles = new Map<string, string>();
  readonly settlementDays: string[] = [];
  settlementFault: SettlementFault = 'ok';
  creates = 0;
  private readonly verifies = new Map<string, number>();
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private baseUrl = '';

  constructor(
    public script: PspScript = {
      onCreate: () => 'ok',
      verify503: () => false,
    },
  ) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.route(req, res));
    this.server.on('connection', (s: Socket) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) =>
      this.server ? this.server.close(() => r()) : r(),
    );
  }

  verifyCalls(token: string): number {
    return this.verifies.get(token) ?? 0;
  }

  /** The file `GET /psp/settlement?date=day` will answer with. */
  setSettlement(day: string, csv: string): void {
    this.settlementFiles.set(day, csv);
  }

  /** The payer completes the payment: `INIT → PAID`, with a bank reference. */
  pay(token: string): void {
    const p = this.payments.get(token);
    if (!p) throw new Error(`no such payment ${token}`);
    p.status = 'PAID';
    p.refId = (
      (BigInt(`0x${randomBytes(8).toString('hex')}`) % 9_000_000_000n) +
      1_000_000_000n
    ).toString();
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.startsWith('/psp/settlement')) {
        return this.settlement(url, req, res);
      }
      if (req.method === 'POST' && url === '/psp/payments') {
        return this.create(
          JSON.parse(raw) as Record<string, unknown>,
          req,
          res,
        );
      }
      if (req.method === 'POST' && url === '/psp/verify') {
        const { token } = JSON.parse(raw) as { token: string };
        return this.verify(token, res);
      }
      const m = /^\/psp\/payments\/([^/]+)$/.exec(url);
      if (req.method === 'GET' && m) return this.get(m[1], res);
      json(res, 404, { code: -9, message: 'not found' });
    });
  }

  private settlement(
    url: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const day = new URL(url, 'http://fake').searchParams.get('date') ?? '';
    this.settlementDays.push(day);
    switch (this.settlementFault) {
      case 'reset':
        return void req.socket.destroy();
      case '503':
        return json(res, 503, { code: -1, message: 'down' });
      case 'html':
        res.writeHead(200, { 'content-type': 'text/html' });
        return void res.end('<html><body>502 Bad Gateway</body></html>');
      case 'json':
        return json(res, 200, { code: -404, message: 'not found' });
      case 'empty':
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
        return void res.end('');
      case 'ok':
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
        return void res.end(
          this.settlementFiles.get(day) ?? SETTLEMENT_HEADER.join(',') + '\r\n',
        );
    }
  }

  private create(
    body: Record<string, unknown>,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    this.creates++;
    const fault = this.script.onCreate(this.creates);
    if (fault === 'timeout') return;
    if (fault === 'reset') return void req.socket.destroy();
    if (fault === '503') return json(res, 503, { code: -1, message: 'down' });
    if (fault === 'reject') {
      return json(res, 400, { code: -12, message: 'amount below minimum' });
    }
    const amount = String(body.amount);
    if (!/^[1-9][0-9]*$/.test(amount)) {
      return json(res, 400, {
        code: -11,
        message: 'amount must be a positive integer',
      });
    }
    const token = `A0${randomBytes(8).toString('hex')}`;
    this.payments.set(token, {
      token,
      orderId: String(body.orderId),
      amount,
      callbackUrl: String(body.callbackUrl),
      status: 'INIT',
      refId: null,
    });
    json(res, 201, {
      code: 100,
      token,
      paymentUrl: `${this.baseUrl}/psp/pay/${token}`,
    });
  }

  private get(token: string, res: ServerResponse): void {
    const p = this.payments.get(token);
    if (!p) return json(res, 404, { code: -9, message: 'unknown token' });
    json(res, 200, {
      token,
      orderId: p.orderId,
      status: p.status,
      amount: p.amount,
      refId: p.refId,
    });
  }

  private verify(token: string, res: ServerResponse): void {
    const attempt = (this.verifies.get(token) ?? 0) + 1;
    this.verifies.set(token, attempt);
    if (this.script.verify503(token, attempt)) {
      return json(res, 503, { code: -1, message: 'service unavailable' });
    }
    const p = this.payments.get(token);
    if (!p) return json(res, 404, { code: -9, message: 'unknown token' });
    if (p.status === 'PAID') {
      p.status = 'VERIFIED';
      return json(res, 200, {
        code: 100,
        status: 'OK',
        amount: p.amount,
        refId: p.refId,
      });
    }
    if (p.status === 'VERIFIED') {
      return json(res, 200, {
        code: 101,
        status: 'ALREADY_VERIFIED',
        amount: p.amount,
        refId: p.refId,
      });
    }
    json(res, 200, {
      code: -51,
      status: 'FAILED',
      message: 'payment not successful',
    });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
