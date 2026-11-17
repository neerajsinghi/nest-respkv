import { Injectable, Logger } from '@nestjs/common';
import { Command } from '../engine/command.decorator.js';
import { Engine } from '../engine/engine.service.js';
import { ServerStats } from '../engine/server-stats.js';
import { Session } from '../engine/session.js';
import { AofService } from '../persistence/aof.service.js';
import { PubSubService } from '../pubsub/pubsub.service.js';
import { Deque } from '../store/deque.js';
import { IndexedSet } from '../store/indexed-set.js';
import { Keyspace } from '../store/keyspace.js';
import { ZSet } from '../store/zset.js';
import { VERSION } from '../version.js';
import { formatScore, is } from './common.js';

/** Elements per command when a rewrite writes out a large collection. */
const SNAPSHOT_CHUNK = 1024;

@Injectable()
export class ServerCommands {
  private readonly logger = new Logger('Server');

  constructor(
    private readonly keyspace: Keyspace,
    private readonly aof: AofService,
    private readonly engine: Engine,
    private readonly stats: ServerStats,
    private readonly pubsub: PubSubService,
  ) {}

  /** Sections are ignored: everything is always returned. */
  @Command('INFO', { arity: -1 })
  info(s: Session): void {
    const lines = [
      '# Server',
      'server:respkv',
      `version:${VERSION}`,
      `node_version:${process.version}`,
      `uptime_in_seconds:${Math.floor((Date.now() - this.stats.startedAt) / 1000)}`,
      '',
      '# Clients',
      `connected_clients:${this.stats.connectedClients}`,
      `pubsub_channels:${this.pubsub.channelCount}`,
      '',
      '# Memory',
      `used_memory:${process.memoryUsage().heapUsed}`,
      '',
      '# Persistence',
      `aof_enabled:${this.aof.enabled ? 1 : 0}`,
    ];
    if (this.aof.enabled) {
      lines.push(
        `aof_current_size:${this.aof.size}`,
        `aof_last_write_status:${this.aof.failed === null ? 'ok' : 'err'}`,
      );
    }
    lines.push(
      '',
      '# Stats',
      `total_connections_received:${this.stats.connections}`,
      `total_commands_processed:${this.stats.commands}`,
      `expired_keys:${this.stats.expiredKeys}`,
      `rejected_clients:${this.stats.rejectedClients}`,
      '',
      '# Keyspace',
    );
    if (this.keyspace.size > 0) {
      lines.push(
        `db0:keys=${this.keyspace.size},expires=${this.keyspace.volatileSize}`,
      );
    }
    s.reply.bulk(lines.join('\r\n') + '\r\n');
  }

  /**
   * redis-cli and some clients query this on connect. An empty table is valid
   * and tells them to use their built-in knowledge.
   */
  @Command('COMMAND', { arity: -1 })
  command(s: Session, args: string[]): void {
    if (args.length === 2 && is(args[1], 'COUNT'))
      s.reply.int(this.engine.commandCount);
    else s.reply.array(0);
  }

  /** Answers CONFIG GET with no matches, as Redis does for an unknown parameter. */
  @Command('CONFIG', { arity: -2 })
  config(s: Session, args: string[]): void {
    if (is(args[1], 'GET')) s.reply.array(0);
    else s.reply.error('ERR CONFIG subcommand not supported');
  }

  /**
   * Compacts the log. It isn't called BGREWRITEAOF because it doesn't run in
   * the background: it blocks every client until it finishes.
   */
  @Command('REWRITEAOF', { arity: 1, noMulti: true })
  rewriteaof(s: Session): void {
    if (!this.aof.enabled) {
      s.reply.error('ERR AOF is not enabled');
      return;
    }
    const started = Date.now();
    try {
      this.aof.rewrite((emit) => this.snapshot(emit));
    } catch (err) {
      this.logger.error(`AOF rewrite failed: ${(err as Error).message}`);
      s.reply.error(`ERR AOF rewrite failed: ${(err as Error).message}`);
      return;
    }
    this.logger.log(
      `AOF rewritten: ${this.aof.size} bytes in ${Date.now() - started} ms`,
    );
    s.reply.simple('OK');
  }

  /**
   * Emits the smallest commands that rebuild the dataset, splitting large
   * collections so no single command is enormous.
   */
  private snapshot(emit: (args: readonly string[]) => void): void {
    for (const [key, value, expireAt] of this.keyspace.entries()) {
      if (typeof value === 'string') {
        emit(['SET', key, value]);
      } else if (value instanceof Deque) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) items.push(value.at(i));
        chunked(emit, 'RPUSH', key, items, 1);
      } else if (value instanceof Map) {
        chunked(emit, 'HSET', key, [...value].flat(), 2);
      } else if (value instanceof IndexedSet) {
        chunked(emit, 'SADD', key, [...value], 1);
      } else if (value instanceof ZSet) {
        const items: string[] = [];
        value.range(0, value.size - 1, (m, score) =>
          items.push(formatScore(score), m),
        );
        chunked(emit, 'ZADD', key, items, 2);
      }
      if (expireAt !== 0) emit(['PEXPIREAT', key, String(expireAt)]);
    }
  }
}

function chunked(
  emit: (args: readonly string[]) => void,
  name: string,
  key: string,
  items: string[],
  width: number,
): void {
  const step = SNAPSHOT_CHUNK * width;
  for (let i = 0; i < items.length; i += step) {
    emit([name, key, ...items.slice(i, i + step)]);
  }
}
