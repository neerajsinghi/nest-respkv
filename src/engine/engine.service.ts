import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { RESPKV_CONFIG } from '../config/config.js';
import type { RespkvConfig } from '../config/config.js';
import { loadAof } from '../persistence/aof-file.js';
import { AofService } from '../persistence/aof.service.js';
import { Propagator } from '../persistence/propagator.js';
import { Keyspace } from '../store/keyspace.js';
import { arityOk, CommandRegistry } from './command-registry.js';
import { ServerStats } from './server-stats.js';
import { Session } from './session.js';

const EXPIRE_INTERVAL_MS = 100;
const EXPIRE_BUDGET_MS = 2;
const EXPIRE_SAMPLE = 20;

/**
 * Runs commands. dispatch is synchronous from start to finish, and so is every
 * handler, so a command runs to completion before any other starts: the event
 * loop does the job a global lock does in a multi-threaded server.
 */
@Injectable()
export class Engine implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Engine');
  private expireTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: CommandRegistry,
    private readonly keyspace: Keyspace,
    private readonly aof: AofService,
    private readonly propagator: Propagator,
    private readonly stats: ServerStats,
    @Inject(RESPKV_CONFIG) private readonly config: RespkvConfig,
  ) {
    keyspace.onExpire = (key) => {
      stats.expiredKeys++;
      propagator.propagate('DEL', key);
    };
  }

  /** Replays the AOF, opens it for appending, and starts active expiry. */
  onApplicationBootstrap(): void {
    if (this.aof.enabled) this.loadLog();
    this.expireTimer = setInterval(
      () => this.activeExpireCycle(),
      EXPIRE_INTERVAL_MS,
    );
  }

  onApplicationShutdown(): void {
    if (this.expireTimer !== null) clearInterval(this.expireTimer);
    this.expireTimer = null;
  }

  get commandCount(): number {
    return this.registry.size;
  }

  /**
   * Applies the checks every command shares, in the same order as Redis, then
   * runs the command or queues it inside MULTI.
   */
  dispatch(s: Session, args: string[]): void {
    this.stats.commands++;
    const cmd = this.registry.get(args[0]);
    if (!s.authenticated && (cmd === undefined || !cmd.noAuth)) {
      s.reply.error('NOAUTH Authentication required.');
      return;
    }
    if (cmd === undefined) {
      s.dirtyExec = s.inMulti;
      s.reply.error(`ERR unknown command '${args[0].slice(0, 128)}'`);
      return;
    }
    if (!arityOk(cmd, args.length)) {
      s.dirtyExec = s.inMulti;
      s.reply.error(
        `ERR wrong number of arguments for '${cmd.name.toLowerCase()}' command`,
      );
      return;
    }
    if (s.channels.size > 0 && !cmd.pubsub) {
      s.reply.error(
        `ERR Can't execute '${cmd.name.toLowerCase()}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`,
      );
      return;
    }
    if (cmd.write && this.aof.failed !== null) {
      s.dirtyExec = s.inMulti;
      s.reply.error(
        'MISCONF Errors writing to the AOF file. Writes are refused until the server restarts.',
      );
      return;
    }
    if (s.inMulti && cmd.name !== 'EXEC' && cmd.name !== 'DISCARD') {
      if (cmd.noMulti) {
        s.dirtyExec = true;
        s.reply.error(
          `ERR Command not allowed inside a transaction: '${cmd.name.toLowerCase()}'`,
        );
        return;
      }
      s.queue.push({ handler: cmd, args });
      s.reply.simple('QUEUED');
      return;
    }
    cmd.fn(s, args);
  }

  /**
   * Runs a transaction's queued commands. As in Redis, a command that fails at
   * run time doesn't undo the others: there's no rollback.
   */
  exec(s: Session): void {
    const queue = s.queue;
    const dirty = s.dirtyExec;
    s.resetTx();
    if (dirty) {
      s.reply.error(
        'EXECABORT Transaction discarded because of previous errors.',
      );
      return;
    }
    if (this.aof.failed !== null && queue.some((q) => q.handler.write)) {
      s.reply.error(
        'EXECABORT Errors writing to the AOF file. Writes are refused until the server restarts.',
      );
      return;
    }
    s.reply.array(queue.length);
    this.propagator.exec(() => {
      for (const q of queue) {
        this.stats.commands++;
        q.handler.fn(s, q.args);
      }
    });
  }

  private loadLog(): void {
    const replay = new Session(0, true, null);
    const started = Date.now();
    this.keyspace.loading = true;
    let res;
    try {
      res = loadAof(this.aof.path, (args) => this.replay(replay, args));
    } finally {
      this.keyspace.loading = false;
    }
    this.logger.log(
      `AOF loaded: ${res.commands} commands, ${this.keyspace.size} keys in ${Date.now() - started} ms`,
    );
    if (res.truncated > 0) {
      this.logger.warn(
        `AOF had an incomplete tail, probably from a crash; removed ${res.truncated} bytes`,
      );
    }
    this.aof.open();
  }

  /**
   * Applies one logged command. Only successful writes are logged, so a
   * command that fails now means the log and the code disagree.
   */
  private replay(s: Session, args: string[]): void {
    const cmd = this.registry.get(args[0]);
    if (cmd === undefined)
      throw new Error(`unknown command '${args[0]}' in log`);
    if (!arityOk(cmd, args.length)) {
      throw new Error(`wrong number of arguments for '${args[0]}' in log`);
    }
    cmd.fn(s, args);
    const out = s.reply.take();
    if (out !== null && out[0] === 0x2d /* '-' */) {
      throw new Error(`${args[0]} failed: ${out.toString('latin1', 1).trim()}`);
    }
  }

  /**
   * The active half of expiry. Like Redis it repeats while the sample says
   * many keys are expired, within a time budget, so that a mass expiry can't
   * hold up the event loop.
   */
  private activeExpireCycle(): void {
    const started = performance.now();
    for (;;) {
      const { checked, expired } = this.keyspace.activeExpire(EXPIRE_SAMPLE);
      if (checked === 0 || expired * 4 < checked) break;
      if (performance.now() - started > EXPIRE_BUDGET_MS) break;
    }
    this.aof.writePending();
  }

  get passwordRequired(): boolean {
    return this.config.password !== '';
  }
}
