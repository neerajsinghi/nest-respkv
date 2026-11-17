import { Injectable } from '@nestjs/common';
import { Command } from '../engine/command.decorator.js';
import { Session } from '../engine/session.js';
import { Propagator } from '../persistence/propagator.js';
import { HashValue, Keyspace } from '../store/keyspace.js';
import {
  addFits,
  ERR_NOT_INT,
  isHash,
  lookup,
  parseInt64,
  WRONG_TYPE,
} from './common.js';

@Injectable()
export class HashCommands {
  constructor(
    private readonly keyspace: Keyspace,
    private readonly propagator: Propagator,
  ) {}

  @Command('HSET', { arity: -4, write: true })
  hset(s: Session, args: string[]): void {
    if (args.length % 2 !== 0) {
      s.reply.error("ERR wrong number of arguments for 'hset' command");
      return;
    }
    let h = lookup(this.keyspace, s, args[1], isHash);
    if (h === WRONG_TYPE) return;
    if (h === undefined) {
      h = new Map();
      this.keyspace.put(args[1], h);
    }
    let added = 0;
    for (let i = 2; i < args.length; i += 2) {
      if (!h.has(args[i])) added++;
      h.set(args[i], args[i + 1]);
    }
    this.propagator.propagate(...args);
    s.reply.int(added);
  }

  @Command('HGET', { arity: 3 })
  hget(s: Session, args: string[]): void {
    const h = lookup(this.keyspace, s, args[1], isHash);
    if (h === WRONG_TYPE) return;
    const v = h?.get(args[2]);
    if (v === undefined) s.reply.null();
    else s.reply.bulk(v);
  }

  @Command('HMGET', { arity: -3 })
  hmget(s: Session, args: string[]): void {
    const h = lookup(this.keyspace, s, args[1], isHash);
    if (h === WRONG_TYPE) return;
    s.reply.array(args.length - 2);
    for (let i = 2; i < args.length; i++) {
      const v = h?.get(args[i]);
      if (v === undefined) s.reply.null();
      else s.reply.bulk(v);
    }
  }

  @Command('HDEL', { arity: -3, write: true })
  hdel(s: Session, args: string[]): void {
    const h = lookup(this.keyspace, s, args[1], isHash);
    if (h === WRONG_TYPE) return;
    let removed = 0;
    for (let i = 2; h !== undefined && i < args.length; i++) {
      if (h.delete(args[i])) removed++;
    }
    if (removed > 0) {
      if (h?.size === 0) this.keyspace.delete(args[1]);
      this.propagator.propagate(...args);
    }
    s.reply.int(removed);
  }

  @Command('HEXISTS', { arity: 3 })
  hexists(s: Session, args: string[]): void {
    const h = lookup(this.keyspace, s, args[1], isHash);
    if (h !== WRONG_TYPE) s.reply.int(h?.has(args[2]) ? 1 : 0);
  }

  @Command('HLEN', { arity: 2 })
  hlen(s: Session, args: string[]): void {
    const h = lookup(this.keyspace, s, args[1], isHash);
    if (h !== WRONG_TYPE) s.reply.int(h?.size ?? 0);
  }

  @Command('HGETALL', { arity: 2 })
  hgetall(s: Session, args: string[]): void {
    const h = this.hashOrEmpty(s, args[1]);
    if (h === WRONG_TYPE) return;
    s.reply.array(h.size * 2);
    for (const [f, v] of h) {
      s.reply.bulk(f);
      s.reply.bulk(v);
    }
  }

  @Command('HKEYS', { arity: 2 })
  hkeys(s: Session, args: string[]): void {
    const h = this.hashOrEmpty(s, args[1]);
    if (h === WRONG_TYPE) return;
    s.reply.array(h.size);
    for (const f of h.keys()) s.reply.bulk(f);
  }

  @Command('HVALS', { arity: 2 })
  hvals(s: Session, args: string[]): void {
    const h = this.hashOrEmpty(s, args[1]);
    if (h === WRONG_TYPE) return;
    s.reply.array(h.size);
    for (const v of h.values()) s.reply.bulk(v);
  }

  @Command('HINCRBY', { arity: 4, write: true })
  hincrby(s: Session, args: string[]): void {
    const d = parseInt64(args[3]);
    if (d === null) {
      s.reply.error(ERR_NOT_INT);
      return;
    }
    let h = lookup(this.keyspace, s, args[1], isHash);
    if (h === WRONG_TYPE) return;
    let cur = 0n;
    const old = h?.get(args[2]);
    if (old !== undefined) {
      const parsed = parseInt64(old);
      if (parsed === null) {
        s.reply.error('ERR hash value is not an integer');
        return;
      }
      cur = parsed;
    }
    if (!addFits(cur, d)) {
      s.reply.error('ERR increment or decrement would overflow');
      return;
    }
    if (h === undefined) {
      h = new Map();
      this.keyspace.put(args[1], h);
    }
    cur += d;
    h.set(args[2], cur.toString());
    this.propagator.propagate(...args);
    s.reply.int(cur);
  }

  private hashOrEmpty(s: Session, key: string): HashValue | typeof WRONG_TYPE {
    return lookup(this.keyspace, s, key, isHash) ?? new Map();
  }
}
