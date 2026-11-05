import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { randomBytes } from 'node:crypto';
import { AddressInfo, Socket } from 'node:net';
import type { PspStatus } from '../psp.port';

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

export interface PspScript {
  onCreate(attempt: number): PspCreateFault;
  verify503(token: string, attempt: number): boolean;
}

/**
 * @class FakePspServer
 * @description A stateful PSP for deposit tests, behaving as probed: unique random tokens, unsigned, no `orderId` de-duplication,
 * verify answers 100 once then 101 with the same `refId` and `-51` for anything not paid, and a 503 verify is not applied.
 * `pay` stands in for the payer on the payment page.
 */
export class FakePspServer {
  readonly payments = new Map<string, FakePayment>();
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

  /** The payer completes the payment: `INIT → PAID`, with a bank reference. */
  pay(token: string): void {
    const p = this.payments.get(token);
    if (!p) throw new Error(`no such payment ${token}`);
    p.status = 'PAID';
    p.refId = `REF${token.slice(-6)}`;
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const url = req.url ?? '';
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
