import * as fs from 'node:fs';
import { connect, Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { DEFAULT_CONFIG, RespkvConfig } from '../src/config/config.js';
import { RespServer } from '../src/network/resp-server.js';
import { encodeCommand } from '../src/resp/reply-writer.js';

export class RespError {
  constructor(readonly message: string) {}
  get kind(): string {
    return this.message.split(' ')[0];
  }
}

/** Integers decode to number, or bigint beyond 2^53. Strings are latin1. */
export type Reply = string | number | bigint | null | RespError | Reply[];

export interface TestServer {
  app: INestApplication;
  port: number;
  config: RespkvConfig;
  close(): Promise<void>;
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'respkv-test-'));
}

/** Starts the whole Nest application on a free port, admin HTTP off. */
export async function startServer(
  overrides: Partial<RespkvConfig> = {},
): Promise<TestServer> {
  const config: RespkvConfig = {
    ...DEFAULT_CONFIG,
    listen: { host: '127.0.0.1', port: 0 },
    admin: null,
    ...overrides,
  };
  const app = await NestFactory.create(AppModule.register(config), {
    logger: false,
  });
  await app.init();
  const { port } = await app.get(RespServer).listen();
  let closed = false;
  return {
    app,
    port,
    config,
    close: async () => {
      if (closed) return;
      closed = true;
      await app.close();
    },
  };
}

/** Parses one reply from buf at pos. Returns null if it isn't complete. */
function parseReply(buf: Buffer, pos: number): [Reply, number] | null {
  const cr = buf.indexOf('\r\n', pos);
  if (cr < 0) return null;
  const line = buf.toString('latin1', pos + 1, cr);
  const next = cr + 2;
  switch (String.fromCharCode(buf[pos])) {
    case '+':
      return [line, next];
    case '-':
      return [new RespError(line), next];
    case ':': {
      const n = BigInt(line);
      return [n >= -(2n ** 53n) && n <= 2n ** 53n ? Number(n) : n, next];
    }
    case '$': {
      const size = Number(line);
      if (size < 0) return [null, next];
      if (buf.length < next + size + 2) return null;
      return [buf.toString('latin1', next, next + size), next + size + 2];
    }
    case '*': {
      const count = Number(line);
      if (count < 0) return [null, next];
      const items: Reply[] = [];
      let p = next;
      for (let i = 0; i < count; i++) {
        const r = parseReply(buf, p);
        if (r === null) return null;
        items.push(r[0]);
        p = r[1];
      }
      return [items, p];
    }
  }
  throw new Error(`bad reply byte ${buf[pos]}`);
}

/** A minimal RESP client that exposes the raw socket, for protocol tests. */
export class RespClient {
  private buf = Buffer.alloc(0);
  private waiters: {
    resolve: (r: Reply) => void;
    reject: (e: Error) => void;
  }[] = [];
  private ready: Reply[] = [];
  readonly closed: Promise<void>;

  private constructor(readonly socket: Socket) {
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const r = parseReply(this.buf, 0);
        if (r === null) break;
        this.buf = this.buf.subarray(r[1]);
        const w = this.waiters.shift();
        if (w) w.resolve(r[0]);
        else this.ready.push(r[0]);
      }
    });
    socket.on('error', () => undefined);
    this.closed = new Promise((resolve) =>
      socket.once('close', () => {
        for (const w of this.waiters.splice(0))
          w.reject(new Error('connection closed'));
        resolve();
      }),
    );
  }

  static connect(port: number): Promise<RespClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () =>
        resolve(new RespClient(socket)),
      );
      socket.once('error', reject);
    });
  }

  send(raw: string | Buffer): void {
    this.socket.write(
      typeof raw === 'string' ? Buffer.from(raw, 'latin1') : raw,
    );
  }

  /** Sends a command without waiting for its reply. */
  write(...args: (string | number)[]): void {
    this.send(encodeCommand(args.map(String)));
  }

  /** Resolves with the next reply. Rejects if the connection closes first. */
  read(timeoutMs = 5000): Promise<Reply> {
    const r = this.ready.shift();
    if (r !== undefined) return Promise.resolve(r);
    if (this.socket.closed)
      return Promise.reject(new Error('connection closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for a reply')),
        timeoutMs,
      );
      this.waiters.push({
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  call(...args: (string | number)[]): Promise<Reply> {
    this.write(...args);
    return this.read();
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Resolves once cond() is true, polling every 10 ms. */
export async function waitFor(
  cond: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
