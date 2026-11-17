import { Injectable } from '@nestjs/common';
import { Command } from '../engine/command.decorator.js';
import { Session } from '../engine/session.js';
import { Propagator } from '../persistence/propagator.js';
import { IndexedSet } from '../store/indexed-set.js';
import { Keyspace } from '../store/keyspace.js';
import { ERR_SYNTAX, isSet, lookup, parseIndex, WRONG_TYPE } from './common.js';

type Members = IndexedSet<string>;
const EMPTY: Members = new IndexedSet();

@Injectable()
export class SetCommands {
  constructor(
    private readonly keyspace: Keyspace,
    private readonly propagator: Propagator,
  ) {}

  @Command('SADD', { arity: -3, write: true })
  sadd(s: Session, args: string[]): void {
    let set = lookup(this.keyspace, s, args[1], isSet);
    if (set === WRONG_TYPE) return;
    if (set === undefined) {
      set = new IndexedSet();
      this.keyspace.put(args[1], set);
    }
    let added = 0;
    for (let i = 2; i < args.length; i++) if (set.add(args[i])) added++;
    if (added > 0) this.propagator.propagate(...args);
    s.reply.int(added);
  }

  @Command('SREM', { arity: -3, write: true })
  srem(s: Session, args: string[]): void {
    const set = lookup(this.keyspace, s, args[1], isSet);
    if (set === WRONG_TYPE) return;
    let removed = 0;
    for (let i = 2; set !== undefined && i < args.length; i++) {
      if (set.delete(args[i])) removed++;
    }
    if (removed > 0) {
      if (set?.size === 0) this.keyspace.delete(args[1]);
      this.propagator.propagate(...args);
    }
    s.reply.int(removed);
  }

  @Command('SISMEMBER', { arity: 3 })
  sismember(s: Session, args: string[]): void {
    const set = lookup(this.keyspace, s, args[1], isSet);
    if (set !== WRONG_TYPE) s.reply.int(set?.has(args[2]) ? 1 : 0);
  }

  @Command('SCARD', { arity: 2 })
  scard(s: Session, args: string[]): void {
    const set = lookup(this.keyspace, s, args[1], isSet);
    if (set !== WRONG_TYPE) s.reply.int(set?.size ?? 0);
  }

  @Command('SMEMBERS', { arity: 2 })
  smembers(s: Session, args: string[]): void {
    const set = lookup(this.keyspace, s, args[1], isSet);
    if (set !== WRONG_TYPE) this.replyMembers(s, set ?? EMPTY);
  }

  /** Removes random members, and logs which ones as SREM so replay matches. */
  @Command('SPOP', { arity: -2, write: true })
  spop(s: Session, args: string[]): void {
    if (args.length > 3) {
      s.reply.error(ERR_SYNTAX);
      return;
    }
    let count = 1;
    if (args.length === 3) {
      const n = parseIndex(args[2]);
      if (n === null || n < 0) {
        s.reply.error('ERR value is out of range, must be positive');
        return;
      }
      count = n;
    }
    const set = lookup(this.keyspace, s, args[1], isSet);
    if (set === WRONG_TYPE) return;
    if (set === undefined) {
      if (args.length === 3) s.reply.array(0);
      else s.reply.null();
      return;
    }
    const n = Math.min(count, set.size);
    if (args.length === 3) s.reply.array(n);
    const log = ['SREM', args[1]];
    for (let i = 0; i < n; i++) {
      const m = set.random() as string;
      set.delete(m);
      s.reply.bulk(m);
      log.push(m);
    }
    if (n > 0) {
      if (set.size === 0) this.keyspace.delete(args[1]);
      this.propagator.propagate(...log);
    }
  }

  @Command('SINTER', { arity: -2 })
  sinter(s: Session, args: string[]): void {
    const sets = this.collect(s, args);
    if (sets === WRONG_TYPE) return;
    const smallest = sets.reduce((a, b) => (b.size < a.size ? b : a));
    const out: string[] = [];
    for (const m of smallest) if (sets.every((set) => set.has(m))) out.push(m);
    this.replyMembers(s, out);
  }

  @Command('SUNION', { arity: -2 })
  sunion(s: Session, args: string[]): void {
    const sets = this.collect(s, args);
    if (sets === WRONG_TYPE) return;
    const out = new Set<string>();
    for (const set of sets) for (const m of set) out.add(m);
    this.replyMembers(s, out);
  }

  @Command('SDIFF', { arity: -2 })
  sdiff(s: Session, args: string[]): void {
    const sets = this.collect(s, args);
    if (sets === WRONG_TYPE) return;
    const out: string[] = [];
    for (const m of sets[0])
      if (!sets.slice(1).some((set) => set.has(m))) out.push(m);
    this.replyMembers(s, out);
  }

  /** Looks up every key; missing keys count as empty sets. */
  private collect(s: Session, args: string[]): Members[] | typeof WRONG_TYPE {
    const sets: Members[] = [];
    for (let i = 1; i < args.length; i++) {
      const set = lookup(this.keyspace, s, args[i], isSet);
      if (set === WRONG_TYPE) return WRONG_TYPE;
      sets.push(set ?? EMPTY);
    }
    return sets;
  }

  private replyMembers(s: Session, members: Iterable<string>): void {
    const list = [...members];
    s.reply.array(list.length);
    for (const m of list) s.reply.bulk(m);
  }
}
