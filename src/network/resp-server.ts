import { createServer, Server, Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { isLoopback, RESPKV_CONFIG } from '../config/config.js';
import type { RespkvConfig } from '../config/config.js';
import { Engine } from '../engine/engine.service.js';
import { ServerStats } from '../engine/server-stats.js';
import { AofService } from '../persistence/aof.service.js';
import { PubSubService } from '../pubsub/pubsub.service.js';
import { Connection, ConnectionDeps } from './connection.js';

const SHUTDOWN_GRACE_MS = 5000;

/**
 * The TCP front end. It is a plain provider that owns a net.Server rather than
 * a Nest microservice transport: transports deliver each message to an async,
 * Observable-returning handler, which would let other clients' commands run in
 * the middle of a transaction. See docs/adr/0002-commands-as-providers.md.
 */
@Injectable()
export class RespServer implements BeforeApplicationShutdown {
  private readonly logger = new Logger('RespServer');
  private server: Server | null = null;
  private readonly connections = new Set<Connection>();
  private nextId = 1;
  private readonly deps: ConnectionDeps;

  constructor(
    engine: Engine,
    aof: AofService,
    pubsub: PubSubService,
    private readonly stats: ServerStats,
    @Inject(RESPKV_CONFIG) private readonly config: RespkvConfig,
  ) {
    this.deps = { engine, aof, pubsub, stats, config, logger: this.logger };
  }

  /** Starts accepting connections. Call after app.init(), which loads the AOF. */
  async listen(): Promise<AddressInfo> {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    const { host, port } = this.config.listen;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address() as AddressInfo;
    this.logger.log(`listening on ${addr.address}:${addr.port}`);
    if (this.config.password === '' && !isLoopback(host)) {
      this.logger.warn(
        'listening beyond loopback with no password; anyone who can reach this port can read and change all data',
      );
    }
    return addr;
  }

  private accept(socket: Socket): void {
    if (this.connections.size >= this.config.maxClients) {
      this.stats.rejectedClients++;
      socket.end('-ERR max number of clients reached\r\n');
      return;
    }
    const conn = new Connection(socket, this.nextId++, this.deps);
    this.connections.add(conn);
    this.stats.connections++;
    this.stats.connectedClients++;
    void conn.done.then(() => this.connections.delete(conn));
  }

  /**
   * Stops accepting, lets each client finish the batch it is running, then
   * closes. Runs before the AOF is closed in onApplicationShutdown, so every
   * acknowledged write is in the file.
   */
  async beforeApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    const closed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    for (const c of this.connections) c.shutdown();
    const all = Promise.all([...this.connections].map((c) => c.done));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SHUTDOWN_GRACE_MS);
    });
    if ((await Promise.race([all, timeout])) === 'timeout') {
      this.logger.warn('clients did not disconnect in time; closing them');
      for (const c of this.connections) c.destroy();
      await all;
    }
    clearTimeout(timer);
    await closed;
  }
}
