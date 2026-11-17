import { Injectable } from '@nestjs/common';
import { Command } from '../engine/command.decorator.js';
import { Session } from '../engine/session.js';
import { Propagator } from '../persistence/propagator.js';
import { Keyspace } from '../store/keyspace.js';
import {
  addFits,
  ERR_NOT_INT,
  ERR_SYNTAX,
  isString,
  lookup,
  parseInt64,
  WRONG_TYPE,
} from './common.js';
import { expiryMillis } from './key.commands.js';

const INT64_MIN = -(2n ** 63n);

@Injectable()
export class StringCommands {
  constructor(
    private readonly keyspace: Keyspace,
    private readonly propagator: Propagator,
  ) {}

  @Command('GET', { arity: 2 })
  get(s: Session, args: string[]): void {
    const v = lookup(this.keyspace, s, args[1], isString);
    if (v === WRONG_TYPE) return;
    if (v === undefined) s.reply.null();
    else s.reply.bulk(v);
  }

  /**
   * SET key value [NX|XX] [GET] [EX s|PX ms|EXAT s|PXAT ms|KEEPTTL]. Any
   * expiry is logged as PXAT, an absolute time.
   */
  @Command('SET', { arity: -3, write: true })
  set(s: Session, args: string[]): void {
    const key = args[1];
    let nx = false;
    let xx = false;
    let get = false;
    let keepTtl = false;
    let at = 0;
    let hasExpiry = false;
    for (let i = 3; i < args.length; i++) {
      const opt = args[i].toUpperCase();
      if (opt === 'NX') nx = true;
      else if (opt === 'XX') xx = true;
      else if (opt === 'GET') get = true;
      else if (opt === 'KEEPTTL') keepTtl = true;
      else if (
        opt === 'EX' ||
        opt === 'PX' ||
        opt === 'EXAT' ||
        opt === 'PXAT'
      ) {
        if (hasExpiry || i + 1 === args.length) {
          s.reply.error(ERR_SYNTAX);
          return;
        }
        const v = parseInt64(args[++i]);
        if (v === null) {
          s.reply.error(ERR_NOT_INT);
          return;
        }
        const unit = opt === 'PX' || opt === 'PXAT' ? 1n : 1000n;
        const absolute = opt === 'EXAT' || opt === 'PXAT';
        const t =
          v > 0n ? expiryMillis(v, unit, absolute, this.keyspace.now()) : null;
        if (t === null) {
          s.reply.error("ERR invalid expire time in 'set' command");
          return;
        }
        at = t;
        hasExpiry = true;
      } else {
        s.reply.error(ERR_SYNTAX);
        return;
      }
    }
    if ((nx && xx) || (keepTtl && hasExpiry)) {
      s.reply.error(ERR_SYNTAX);
      return;
    }

    let old: string | undefined;
    if (get) {
      const v = lookup(this.keyspace, s, key, isString);
      if (v === WRONG_TYPE) return;
      old = v;
    }
    const reply = (applied: boolean): void => {
      if (get && old !== undefined) s.reply.bulk(old);
      else if (get || !applied) s.reply.null();
      else s.reply.simple('OK');
    };

    const exists = this.keyspace.get(key) !== undefined;
    if ((nx && exists) || (xx && !exists)) {
      reply(false);
      return;
    }
    if (hasExpiry && at <= this.keyspace.now() && !this.keyspace.loading) {
      if (this.keyspace.delete(key)) this.propagator.propagate('DEL', key);
      reply(true);
      return;
    }
    if (keepTtl) at = this.keyspace.expireAt(key);
    this.keyspace.put(key, args[2], at);
    if (at !== 0)
      this.propagator.propagate('SET', key, args[2], 'PXAT', String(at));
    else this.propagator.propagate('SET', key, args[2]);
    reply(true);
  }

  @Command('SETNX', { arity: 3, write: true })
  setnx(s: Session, args: string[]): void {
    if (this.keyspace.get(args[1]) !== undefined) {
      s.reply.int(0);
      return;
    }
    this.keyspace.put(args[1], args[2]);
    this.propagator.propagate('SET', args[1], args[2]);
    s.reply.int(1);
  }

  @Command('SETEX', { arity: 4, write: true })
  setex(s: Session, args: string[]): void {
    this.setWithExpiry(s, args, 1000n);
  }

  @Command('PSETEX', { arity: 4, write: true })
  psetex(s: Session, args: string[]): void {
    this.setWithExpiry(s, args, 1n);
  }

  private setWithExpiry(s: Session, args: string[], unit: bigint): void {
    const v = parseInt64(args[2]);
    if (v === null) {
      s.reply.error(ERR_NOT_INT);
      return;
    }
    const at =
      v > 0n ? expiryMillis(v, unit, false, this.keyspace.now()) : null;
    if (at === null) {
      s.reply.error(
        `ERR invalid expire time in '${args[0].toLowerCase()}' command`,
      );
      return;
    }
    this.keyspace.put(args[1], args[3], at);
    this.propagator.propagate('SET', args[1], args[3], 'PXAT', String(at));
    s.reply.simple('OK');
  }

  @Command('GETDEL', { arity: 2, write: true })
  getdel(s: Session, args: string[]): void {
    const v = lookup(this.keyspace, s, args[1], isString);
    if (v === WRONG_TYPE) return;
    if (v === undefined) {
      s.reply.null();
      return;
    }
    this.keyspace.delete(args[1]);
    this.propagator.propagate('DEL', args[1]);
    s.reply.bulk(v);
  }

  @Command('MGET', { arity: -2 })
  mget(s: Session, args: string[]): void {
    s.reply.array(args.length - 1);
    for (let i = 1; i < args.length; i++) {
      const v = this.keyspace.get(args[i]);
      if (typeof v === 'string') s.reply.bulk(v);
      else s.reply.null();
    }
  }

  @Command('MSET', { arity: -3, write: true })
  mset(s: Session, args: string[]): void {
    if (args.length % 2 === 0) {
      s.reply.error("ERR wrong number of arguments for 'mset' command");
      return;
    }
    for (let i = 1; i < args.length; i += 2)
      this.keyspace.put(args[i], args[i + 1]);
    this.propagator.propagate(...args);
    s.reply.simple('OK');
  }

  /**
   * V8 represents a repeated append as a rope, so this doesn't copy the whole
   * value each time; it's flattened once when next read.
   */
  @Command('APPEND', { arity: 3, write: true })
  append(s: Session, args: string[]): void {
    const v = lookup(this.keyspace, s, args[1], isString);
    if (v === WRONG_TYPE) return;
    let next: string;
    if (v === undefined) {
      next = args[2];
      this.keyspace.put(args[1], next);
    } else {
      next = v + args[2];
      this.keyspace.replace(args[1], next);
    }
    this.propagator.propagate(...args);
    s.reply.int(next.length);
  }

  @Command('STRLEN', { arity: 2 })
  strlen(s: Session, args: string[]): void {
    const v = lookup(this.keyspace, s, args[1], isString);
    if (v !== WRONG_TYPE) s.reply.int(v?.length ?? 0);
  }

  @Command('INCR', { arity: 2, write: true })
  incr(s: Session, args: string[]): void {
    this.incrBy(s, args, 1n);
  }

  @Command('DECR', { arity: 2, write: true })
  decr(s: Session, args: string[]): void {
    this.incrBy(s, args, -1n);
  }

  @Command('INCRBY', { arity: 3, write: true })
  incrby(s: Session, args: string[]): void {
    const d = parseInt64(args[2]);
    if (d === null) s.reply.error(ERR_NOT_INT);
    else this.incrBy(s, args, d);
  }

  @Command('DECRBY', { arity: 3, write: true })
  decrby(s: Session, args: string[]): void {
    const d = parseInt64(args[2]);
    if (d === null) s.reply.error(ERR_NOT_INT);
    else if (d === INT64_MIN) s.reply.error('ERR decrement would overflow');
    else this.incrBy(s, args, -d);
  }

  /** Keeps the key's TTL. Arithmetic is on BigInt, so all of int64 is exact. */
  private incrBy(s: Session, args: string[], delta: bigint): void {
    const v = lookup(this.keyspace, s, args[1], isString);
    if (v === WRONG_TYPE) return;
    let cur = 0n;
    if (v !== undefined) {
      const parsed = parseInt64(v);
      if (parsed === null) {
        s.reply.error(ERR_NOT_INT);
        return;
      }
      cur = parsed;
    }
    if (!addFits(cur, delta)) {
      s.reply.error('ERR increment or decrement would overflow');
      return;
    }
    cur += delta;
    if (v === undefined) this.keyspace.put(args[1], cur.toString());
    else this.keyspace.replace(args[1], cur.toString());
    this.propagator.propagate(...args);
    s.reply.int(cur);
  }
}
