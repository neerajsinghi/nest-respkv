import type { Socket } from 'node:net';
import { Logger } from '@nestjs/common';
import type { RespkvConfig } from '../config/config.js';
import type { Engine } from '../engine/engine.service.js';
import type { ServerStats } from '../engine/server-stats.js';
import { OutputSink, Session } from '../engine/session.js';
import type { AofService } from '../persistence/aof.service.js';
import type { PubSubService } from '../pubsub/pubsub.service.js';
import { InputBuffer } from '../resp/input-buffer.js';
import {
  DEFAULT_LIMITS,
  parseCommand,
  ProtocolError,
  UNAUTH_LIMITS,
} from '../resp/parser.js';

/** Commands run before yielding to other connections. */
const MAX_BATCH = 1024;
/** Reply bytes built before yielding, so a pipeline of large GETs takes turns. */
const MAX_BATCH_REPLY = 256 * 1024;
/** Replies held for an fsync before the connection stops reading. */
const MAX_HELD_BYTES = 4 * 1024 * 1024;

export interface ConnectionDeps {
  engine: Engine;
  aof: AofService;
  pubsub: PubSubService;
  stats: ServerStats;
  config: RespkvConfig;
  logger: Logger;
}

interface Held {
  buf: Buffer;
  /** The log position this output depends on. */
  pos: number;
}

/**
 * One client connection. Input is parsed and executed in batches, and the
 * batch's replies go out together.
 *
 * Every byte sent is tagged with the AOF position at the time it was produced
 * and is held until that position is durable, when the policy is `always`. A
 * reply to a read is held too if it might reflect another client's write that
 * isn't durable yet. Output keeps its order: nothing overtakes held output.
 *
 * Reading stops while the socket can't keep up, while the batch had to be cut
 * short, or while too much output is held, so one connection's memory stays
 * bounded however fast its client sends.
 */
export class Connection implements OutputSink {
  readonly session: Session;
  private readonly input = new InputBuffer();
  private held: Held[] = [];
  private heldBytes = 0;
  private waiting = false; // registered with the AOF for the first held item
  private scheduled = false; // a pump is queued with setImmediate
  private unfinished = false; // the last pump stopped with commands left to run
  private paused = false;
  private drainTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly closedPromise: Promise<void>;

  constructor(
    private readonly socket: Socket,
    id: number,
    private readonly deps: ConnectionDeps,
  ) {
    this.session = new Session(id, deps.config.password === '', this);
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('drain', () => this.onDrain());
    socket.on('error', () => socket.destroy());
    this.closedPromise = new Promise((resolve) =>
      socket.once('close', () => resolve()),
    );
    socket.once('close', () => this.onClose());
  }

  /** Resolves once the socket has closed. */
  get done(): Promise<void> {
    return this.closedPromise;
  }

  private onData(chunk: Buffer): void {
    this.input.append(chunk);
    if (this.input.length > this.deps.config.maxQueryBytes) {
      this.protocolError('ERR Protocol error: query buffer limit exceeded');
      return;
    }
    if (!this.scheduled) this.pump();
  }

  /**
   * Parses and runs commands until the input runs out or the batch hits its
   * limits, then sends the replies. Everything up to the send is synchronous.
   */
  private pump(): void {
    this.scheduled = false;
    this.unfinished = false;
    if (this.closed || this.socket.destroyed) return;
    if (this.backedUp()) {
      this.unfinished = true;
      this.updateReading();
      return;
    }
    const { engine, aof } = this.deps;
    const s = this.session;
    const failedBefore = aof.failed !== null;
    let n = 0;
    while (this.input.length > 0 && !s.quit) {
      if (n >= MAX_BATCH || s.reply.length >= MAX_BATCH_REPLY) {
        this.unfinished = true;
        break;
      }
      let parsed;
      try {
        parsed = parseCommand(
          this.input.buf,
          this.input.start,
          this.input.end,
          s.authenticated ? DEFAULT_LIMITS : UNAUTH_LIMITS,
        );
      } catch (err) {
        if (!(err instanceof ProtocolError)) throw err;
        this.flush(failedBefore);
        this.protocolError(`ERR ${err.message}`);
        return;
      }
      if (parsed === null) break;
      this.input.consume(parsed.consumed);
      if (parsed.args.length === 0) continue;
      engine.dispatch(s, parsed.args);
      n++;
    }
    if (!this.flush(failedBefore)) return;
    if (s.quit) {
      this.endAfterOutput();
      return;
    }
    this.updateReading();
  }

  /** The client isn't keeping up, so no more commands should run for it yet. */
  private backedUp(): boolean {
    return this.socket.writableNeedDrain || this.heldBytes > MAX_HELD_BYTES;
  }

  /**
   * Writes the AOF, then sends or holds the batch's replies. Returns false if
   * the connection was closed instead: when the log fails during this batch,
   * its writes may not be recorded, so nothing in it is acknowledged.
   */
  private flush(failedBefore: boolean): boolean {
    const { aof } = this.deps;
    aof.writePending();
    if (!failedBefore && aof.failed !== null) {
      this.socket.destroy();
      return false;
    }
    const out = this.session.reply.take();
    if (out !== null) this.send(out);
    return true;
  }

  /** Pub/sub delivery. A subscriber that is too far behind is disconnected. */
  push(buf: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    const backlog = this.socket.writableLength + this.heldBytes + buf.length;
    if (backlog > this.deps.config.maxOutboxBytes) {
      this.deps.stats.rejectedClients++;
      this.deps.logger.warn(
        `disconnecting slow subscriber ${this.socket.remoteAddress ?? ''}`,
      );
      this.socket.destroy();
      return;
    }
    this.send(buf);
    this.updateReading();
  }

  private send(buf: Buffer): void {
    const { aof } = this.deps;
    const pos = aof.position;
    if (this.held.length === 0 && !aof.mustWait(pos)) {
      this.write(buf);
      return;
    }
    this.held.push({ buf, pos });
    this.heldBytes += buf.length;
    this.waitForLog();
  }

  private waitForLog(): void {
    if (this.waiting || this.held.length === 0) return;
    this.waiting = true;
    this.deps.aof.whenDurable(this.held[0].pos, (err) => {
      this.waiting = false;
      if (this.closed || this.socket.destroyed) return;
      if (err !== null) {
        // Not durable, so not acknowledged.
        this.socket.destroy();
        return;
      }
      this.release();
    });
  }

  private release(): void {
    const { aof } = this.deps;
    while (this.held.length > 0 && !aof.mustWait(this.held[0].pos)) {
      const h = this.held.shift() as Held;
      this.heldBytes -= h.buf.length;
      this.write(h.buf);
    }
    this.waitForLog();
    if (this.session.quit && this.held.length === 0) this.socket.end();
    this.updateReading();
  }

  private write(buf: Buffer): void {
    if (!this.socket.write(buf) && this.drainTimer === null) {
      // A client that stops reading is dropped rather than kept forever.
      this.drainTimer = setTimeout(() => {
        this.deps.logger.warn(
          `dropping client that stopped reading ${this.socket.remoteAddress ?? ''}`,
        );
        this.socket.destroy();
      }, this.deps.config.writeTimeoutMs);
    }
  }

  private onDrain(): void {
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.updateReading();
  }

  /**
   * Pauses reading while this connection has unfinished work or is backed up.
   * Once it isn't backed up, unfinished work is scheduled on a later turn of
   * the event loop, so other connections run in between, and reading resumes
   * when no work is left.
   */
  private updateReading(): void {
    if (this.closed || this.socket.destroyed) return;
    if (
      this.unfinished &&
      !this.scheduled &&
      !this.backedUp() &&
      !this.session.quit
    ) {
      this.scheduled = true;
      setImmediate(() => this.pump());
    }
    const busy =
      this.unfinished || this.scheduled || this.backedUp() || this.session.quit;
    if (busy && !this.paused) {
      this.paused = true;
      this.socket.pause();
    } else if (!busy && this.paused) {
      this.paused = false;
      this.socket.resume();
    }
  }

  private protocolError(msg: string): void {
    this.session.reply.error(msg);
    const out = this.session.reply.take();
    if (out !== null) this.send(out);
    this.session.quit = true;
    this.endAfterOutput();
  }

  /** Closes the connection once held output has gone out. */
  private endAfterOutput(): void {
    this.updateReading();
    if (this.held.length === 0) this.socket.end();
  }

  /**
   * Stops reading new commands, lets output finish, then closes. Used at
   * shutdown.
   */
  shutdown(): void {
    if (this.closed || this.socket.destroyed) return;
    this.session.quit = true;
    this.endAfterOutput();
  }

  destroy(): void {
    this.socket.destroy();
  }

  private onClose(): void {
    this.closed = true;
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.deps.pubsub.unsubscribeAll(this.session);
    this.deps.stats.connectedClients--;
  }
}
