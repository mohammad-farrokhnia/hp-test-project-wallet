import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import type { TransferStatus } from '../payout.port';

/**
 * How the fake answers one create (POST), per probe finding:
 * - `ok`: 202 when new, 200 replay of the original when the requestId exists;
 * - `503-created`: creates it, answers 503;
 * - `503-lost`: answers 503, creates nothing;
 * - `timeout-created`: creates it, never answers;
 * - `reset-created`: creates it, resets the connection.
 */
export type CreateFault =
  'ok' | '503-created' | '503-lost' | 'timeout-created' | 'reset-created';

export interface FakeTransfer {
  readonly requestId: string;
  readonly body: Record<string, unknown>;
  final: TransferStatus;
  /** GETs answered so far: ACCEPTED, then PROCESSING, then `final`. */
  gets: number;
}

export interface FakeScript {
  /** The fault for this create; `attempt` counts POSTs for this requestId, from 1. */
  onCreate(requestId: string, attempt: number): CreateFault;
  /** Where the transfer ends up. */
  finalStatus(requestId: string): TransferStatus;
}

/**
 * @class FakePayoutServer
 * @description A stateful payout service for crash and chaos tests (X11). De-duplicates by requestId like the real one (PAY-02), and fails per finding (`CreateFault`). Counts every POST and every transfer, so a test can prove "one transfer per requestId" from the provider's side.
 */
export class FakePayoutServer {
  readonly transfers = new Map<string, FakeTransfer>();
  readonly posts = new Map<string, number>();
  private server?: Server;
  private readonly sockets = new Set<Socket>();

  constructor(
    public script: FakeScript = {
      onCreate: () => 'ok',
      finalStatus: () => 'SUCCEEDED',
    },
  ) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.route(req, res));
    this.server.on('connection', (s: Socket) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy(); // including requests left hanging on purpose
    await new Promise<void>((r) =>
      this.server ? this.server.close(() => r()) : r(),
    );
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/payout/transfers') {
        this.create(JSON.parse(raw) as Record<string, unknown>, req, res);
        return;
      }
      const m = /^\/payout\/transfers\/([^/]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && m) {
        this.get(decodeURIComponent(m[1]), res);
        return;
      }
      json(res, 404, { error: 'NOT_FOUND' });
    });
  }

  private create(
    body: Record<string, unknown>,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const requestId = String(body.requestId);
    const attempt = (this.posts.get(requestId) ?? 0) + 1;
    this.posts.set(requestId, attempt);
    const fault = this.script.onCreate(requestId, attempt);
    const existing = this.transfers.get(requestId);

    if (fault === '503-lost')
      return json(res, 503, { error: 'UPSTREAM_UNAVAILABLE' });
    if (!existing) {
      this.transfers.set(requestId, {
        requestId,
        body,
        final: this.script.finalStatus(requestId),
        gets: 0,
      });
    }
    const transfer = this.transfers.get(requestId)!;
    if (fault === '503-created')
      return json(res, 503, { error: 'UPSTREAM_UNAVAILABLE' });
    if (fault === 'timeout-created') return; // never answers
    if (fault === 'reset-created') return void req.socket.destroy();
    json(res, existing ? 200 : 202, this.view(transfer, 'ACCEPTED'));
  }

  private get(requestId: string, res: ServerResponse): void {
    const t = this.transfers.get(requestId);
    if (!t) return json(res, 404, { error: 'NOT_FOUND' });
    t.gets++;
    const status: TransferStatus =
      t.gets === 1 ? 'ACCEPTED' : t.gets === 2 ? 'PROCESSING' : t.final;
    json(res, 200, this.view(t, status));
  }

  private view(t: FakeTransfer, status: TransferStatus) {
    return {
      requestId: t.requestId,
      trackingId: `TRK-${t.requestId.slice(0, 8)}`,
      status,
      reason:
        status === 'FAILED'
          ? 'INVALID_IBAN'
          : status === 'RETURNED'
            ? 'ACCOUNT_CLOSED'
            : null,
      amount: t.body.amount,
      currency: t.body.currency,
      destination: t.body.destination,
      updatedAt: new Date().toISOString(),
    };
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
