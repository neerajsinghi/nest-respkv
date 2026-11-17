import { Injectable } from '@nestjs/common';
import { Command } from '../engine/command.decorator.js';
import { Session } from '../engine/session.js';
import { Propagator } from '../persistence/propagator.js';
import { globMatch } from '../store/glob.js';
import { Keyspace, typeName } from '../store/keyspace.js';
import { ERR_NO_KEY, ERR_NOT_INT, parseInt64 } from './common.js';

/** Largest time a JS number holds exactly, in unix milliseconds. */
const MAX_TIME_MS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Converts an expiry argument to absolute unix milliseconds, or null if it is
 * out of range. Redis allows any int64 here; this server stops at 2^53 ms,
 * some 285,000 years out, because times are JS numbers.
 */
export function expiryMillis(
  v: bigint,
  unit: bigint,
  absolute: boolean,
  now: number,
): number | null {
  let at = v * unit;
  if (!absolute) at += BigInt(now);
  if (at > MAX_TIME_MS || at < -MAX_TIME_MS) return null;
  return Math.max(Number(at), 1);
}

@Injectable()
export class KeyCommands {
  constructor(
    private readonly keyspace: Keyspace,
    private readonly propagator: Propagator,
  ) {}

  @Command('DEL', { arity: -2, write: true })
  @Command('UNLINK', { arity: -2, write: true })
  del(s: Session, args: string[]): void {
    let n = 0;
    for (let i = 1; i < args.length; i++) {
      if (this.keyspace.delete(args[i])) {
        n++;
        this.propagator.propagate('DEL', args[i]);
      }
    }
    s.reply.int(n);
  }

  @Command('EXISTS', { arity: -2 })
  exists(s: Session, args: string[]): void {
    let n = 0;
    for (let i = 1; i < args.length; i++) {
      if (this.keyspace.get(args[i]) !== undefined) n++;
    }
    s.reply.int(n);
  }

  @Command('TYPE', { arity: 2 })
  type(s: Session, args: string[]): void {
    const v = this.keyspace.get(args[1]);
    s.reply.simple(v === undefined ? 'none' : typeName(v));
  }

  /** Scans every key, blocking all clients while it runs. Avoid on large datasets. */
  @Command('KEYS', { arity: 2 })
  keys(s: Session, args: string[]): void {
    const out: string[] = [];
    for (const [key] of this.keyspace.entries()) {
      if (globMatch(args[1], key)) out.push(key);
    }
    s.reply.array(out.length);
    for (const k of out) s.reply.bulk(k);
  }

  @Command('RENAME', { arity: 3, write: true })
  rename(s: Session, args: string[]): void {
    if (!this.keyspace.rename(args[1], args[2])) {
      s.reply.error(ERR_NO_KEY);
      return;
    }
    this.propagator.propagate(...args);
    s.reply.simple('OK');
  }

  @Command('EXPIRE', { arity: 3, write: true })
  expire(s: Session, args: string[]): void {
    this.setExpiry(s, args, 1000n, false);
  }

  @Command('PEXPIRE', { arity: 3, write: true })
  pexpire(s: Session, args: string[]): void {
    this.setExpiry(s, args, 1n, false);
  }

  @Command('EXPIREAT', { arity: 3, write: true })
  expireat(s: Session, args: string[]): void {
    this.setExpiry(s, args, 1000n, true);
  }

  @Command('PEXPIREAT', { arity: 3, write: true })
  pexpireat(s: Session, args: string[]): void {
    this.setExpiry(s, args, 1n, true);
  }

  /**
   * Every form is logged as PEXPIREAT with an absolute time, so replay gives
   * the same deadline no matter when it happens.
   */
  private setExpiry(
    s: Session,
    args: string[],
    unit: bigint,
    absolute: boolean,
  ): void {
    const v = parseInt64(args[2]);
    if (v === null) {
      s.reply.error(ERR_NOT_INT);
      return;
    }
    const at = expiryMillis(v, unit, absolute, this.keyspace.now());
    if (at === null) {
      s.reply.error(
        `ERR invalid expire time in '${args[0].toLowerCase()}' command`,
      );
      return;
    }
    const key = args[1];
    if (this.keyspace.get(key) === undefined) {
      s.reply.int(0);
      return;
    }
    if (at <= this.keyspace.now() && !this.keyspace.loading) {
      this.keyspace.delete(key);
      this.propagator.propagate('DEL', key);
    } else {
      this.keyspace.setExpire(key, at);
      this.propagator.propagate('PEXPIREAT', key, String(at));
    }
    s.reply.int(1);
  }

  @Command('TTL', { arity: 2 })
  ttl(s: Session, args: string[]): void {
    this.remaining(s, args[1], 1000);
  }

  @Command('PTTL', { arity: 2 })
  pttl(s: Session, args: string[]): void {
    this.remaining(s, args[1], 1);
  }

  private remaining(s: Session, key: string, unit: number): void {
    if (this.keyspace.get(key) === undefined) {
      s.reply.int(-2);
      return;
    }
    const at = this.keyspace.expireAt(key);
    if (at === 0) {
      s.reply.int(-1);
      return;
    }
    const ms = Math.max(at - this.keyspace.now(), 0);
    s.reply.int(Math.floor((ms + unit / 2) / unit));
  }

  @Command('PERSIST', { arity: 2, write: true })
  persist(s: Session, args: string[]): void {
    if (!this.keyspace.persist(args[1])) {
      s.reply.int(0);
      return;
    }
    this.propagator.propagate(...args);
    s.reply.int(1);
  }

  @Command('DBSIZE', { arity: 1 })
  dbsize(s: Session): void {
    s.reply.int(this.keyspace.size);
  }

  /** There's one database, so both flush everything. ASYNC is accepted and ignored. */
  @Command('FLUSHALL', { arity: -1, write: true })
  @Command('FLUSHDB', { arity: -1, write: true })
  flush(s: Session): void {
    this.keyspace.flush();
    this.propagator.propagate('FLUSHALL');
    s.reply.simple('OK');
  }
}
