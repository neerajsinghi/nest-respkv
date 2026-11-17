import * as fs from 'node:fs';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import { RESPKV_CONFIG } from '../config/config.js';
import type { FsyncPolicy, RespkvConfig } from '../config/config.js';
import { ReplyWriter } from '../resp/reply-writer.js';
import { syncDir, writeAll } from './aof-file.js';

const REWRITE_CHUNK = 1024 * 1024;

interface Waiter {
  pos: number;
  done: (err: Error | null) => void;
}

/**
 * The append-only file: every write is recorded as a plain RESP command, and
 * replaying the file rebuilds the dataset.
 *
 * Positions are byte counts of everything ever written, so they keep growing
 * across rewrites. A connection notes the position after its commands were
 * written and holds its replies until that position is durable, which is how
 * `always` acknowledges nothing that a power cut could still lose.
 *
 * Writing is synchronous and happens before replies leave, so even under
 * `everysec` and `no` a crash of this process loses nothing that was
 * acknowledged. Only fsync runs in the background, on libuv's thread pool, so
 * a slow disk never stops the event loop. See docs/adr/0003-group-commit.md.
 */
@Injectable()
export class AofService implements OnApplicationShutdown {
  private readonly logger = new Logger('AOF');
  readonly enabled: boolean;
  readonly policy: FsyncPolicy;
  private readonly file: string;

  private fd = -1;
  private retiredFds: number[] = [];
  private pending = new ReplyWriter();
  private written = 0;
  private durableTo = 0;
  private syncing = false;
  private waiters: Waiter[] = [];
  private timer: NodeJS.Timeout | null = null;

  /**
   * The failure that stopped the log, if any. From then on writes are refused,
   * since they could no longer be made durable. Clearing it takes a restart.
   */
  failed: Error | null = null;
  /** Current file size in bytes. */
  size = 0;

  constructor(@Inject(RESPKV_CONFIG) config: RespkvConfig) {
    this.file = config.aofPath;
    this.enabled = config.aofPath !== '';
    this.policy = config.appendfsync;
  }

  get path(): string {
    return this.file;
  }

  /** Opens the file for appending, after it has been replayed. */
  open(): void {
    this.fd = fs.openSync(this.file, 'a', 0o600);
    this.size = fs.fstatSync(this.fd).size;
    syncDir(this.file);
    if (this.policy === 'everysec') {
      this.timer = setInterval(() => {
        if (this.written > this.durableTo) this.startSync();
      }, 1000);
    }
  }

  /**
   * Buffers a command. Nothing reaches the file until writePending. After a
   * failure commands are dropped: writing past a failed or partial write would
   * leave a hole in the middle of the file.
   */
  append(args: readonly string[]): void {
    if (this.fd >= 0 && this.failed === null) this.pending.command(args);
  }

  /**
   * Writes buffered commands to the file, without fsync. Connections call this
   * before sending replies.
   */
  writePending(): void {
    const buf = this.pending.take();
    if (buf === null || this.failed !== null) return;
    try {
      writeAll(this.fd, buf);
    } catch (err) {
      this.fail(err as Error);
      return;
    }
    this.size += buf.length;
    this.written += buf.length;
  }

  /** The log position after everything written so far. */
  get position(): number {
    return this.written;
  }

  /** Reports whether a reply produced at pos has to wait for an fsync. */
  mustWait(pos: number): boolean {
    return (
      this.policy === 'always' && this.failed === null && pos > this.durableTo
    );
  }

  /**
   * Calls done once the log is durable up to pos, or with an error if the log
   * fails first. This is group commit: one fsync runs at a time, and because
   * the event loop keeps executing commands meanwhile, the next fsync covers
   * all of them at once. Throughput therefore grows with the number of
   * clients, where one fsync per write would be capped by the disk.
   */
  whenDurable(pos: number, done: (err: Error | null) => void): void {
    if (!this.mustWait(pos)) {
      done(this.failed);
      return;
    }
    this.waiters.push({ pos, done });
    this.startSync();
  }

  private startSync(): void {
    if (this.syncing || this.failed !== null || this.fd < 0) return;
    this.syncing = true;
    const fd = this.fd;
    const target = this.written;
    fs.fsync(fd, (err) => {
      this.syncing = false;
      for (const old of this.retiredFds.splice(0)) fs.closeSync(old);
      // If a rewrite replaced the file meanwhile, it fsynced the replacement,
      // and an error here concerns a file that is no longer the log.
      if (err && fd === this.fd) {
        this.fail(err);
        return;
      }
      this.durableTo = Math.max(this.durableTo, target);
      this.release();
      if (this.waiters.length > 0) this.startSync();
    });
  }

  private release(): void {
    const ready: Waiter[] = [];
    this.waiters = this.waiters.filter((w) => {
      if (w.pos > this.durableTo) return true;
      ready.push(w);
      return false;
    });
    for (const w of ready) w.done(null);
  }

  private fail(err: Error): void {
    if (this.failed !== null) return;
    this.failed = err;
    this.pending.reset();
    this.logger.error(
      `AOF failed, refusing writes until restart: ${err.message}`,
    );
    for (const w of this.waiters.splice(0)) w.done(err);
  }

  /**
   * Replaces the log with the smallest commands that rebuild the dataset, as
   * produced by snapshot. The new file is written and fsynced before an atomic
   * rename, so a crash at any point leaves one complete log. On failure the old
   * log stays in use and healthy.
   *
   * This is synchronous, so it blocks every client while it runs. A background
   * rewrite would need a copy-on-write snapshot, which Redis gets from fork.
   */
  rewrite(snapshot: (emit: (args: readonly string[]) => void) => void): void {
    if (this.failed !== null) throw this.failed;
    const tmpPath = this.file + '.tmp';
    const tmp = fs.openSync(tmpPath, 'w', 0o600);
    let size = 0;
    try {
      const w = new ReplyWriter();
      const flush = (): void => {
        const buf = w.take();
        if (buf !== null) {
          writeAll(tmp, buf);
          size += buf.length;
        }
      };
      snapshot((args) => {
        w.command(args);
        if (w.length >= REWRITE_CHUNK) flush();
      });
      flush();
      fs.fsyncSync(tmp);
      fs.renameSync(tmpPath, this.file);
    } catch (err) {
      fs.closeSync(tmp);
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
    // The rename happened, so tmp is the log now, whatever follows.
    const old = this.fd;
    this.fd = tmp;
    if (this.syncing) this.retiredFds.push(old);
    else fs.closeSync(old);
    this.size = size;
    this.pending.reset(); // anything buffered is part of the snapshot
    this.durableTo = this.written;
    try {
      syncDir(this.file);
    } catch (err) {
      this.fail(err as Error);
      throw err;
    }
    this.release();
  }

  /** Writes and fsyncs everything, then closes the file. */
  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.fd < 0) return;
    this.writePending();
    try {
      if (this.failed === null) fs.fsyncSync(this.fd);
    } finally {
      fs.closeSync(this.fd);
      this.fd = -1;
    }
  }
}
