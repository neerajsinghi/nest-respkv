import { Injectable } from '@nestjs/common';
import { Command } from '../engine/command.decorator.js';
import { Session } from '../engine/session.js';
import { Propagator } from '../persistence/propagator.js';
import { Deque, normalizeRange } from '../store/deque.js';
import { Keyspace } from '../store/keyspace.js';
import {
  ERR_NO_KEY,
  ERR_NOT_INT,
  isList,
  lookup,
  parseIndex,
  WRONG_TYPE,
} from './common.js';

@Injectable()
export class ListCommands {
  constructor(
    private readonly keyspace: Keyspace,
    private readonly propagator: Propagator,
  ) {}

  @Command('LPUSH', { arity: -3, write: true })
  lpush(s: Session, args: string[]): void {
    this.push(s, args, true);
  }

  @Command('RPUSH', { arity: -3, write: true })
  rpush(s: Session, args: string[]): void {
    this.push(s, args, false);
  }

  private push(s: Session, args: string[], front: boolean): void {
    let l = lookup(this.keyspace, s, args[1], isList);
    if (l === WRONG_TYPE) return;
    if (l === undefined) {
      l = new Deque<string>();
      this.keyspace.put(args[1], l);
    }
    for (let i = 2; i < args.length; i++) {
      if (front) l.pushFront(args[i]);
      else l.pushBack(args[i]);
    }
    this.propagator.propagate(...args);
    s.reply.int(l.length);
  }

  @Command('LPOP', { arity: -2, write: true })
  lpop(s: Session, args: string[]): void {
    this.pop(s, args, true);
  }

  @Command('RPOP', { arity: -2, write: true })
  rpop(s: Session, args: string[]): void {
    this.pop(s, args, false);
  }

  private pop(s: Session, args: string[], front: boolean): void {
    if (args.length > 3) {
      s.reply.error(
        `ERR wrong number of arguments for '${args[0].toLowerCase()}' command`,
      );
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
    const l = lookup(this.keyspace, s, args[1], isList);
    if (l === WRONG_TYPE) return;
    if (l === undefined) {
      if (args.length === 3) s.reply.nullArray();
      else s.reply.null();
      return;
    }
    const take = (): string => (front ? l.popFront() : l.popBack()) as string;
    if (args.length === 2) {
      s.reply.bulk(take());
    } else {
      const n = Math.min(count, l.length);
      s.reply.array(n);
      for (let i = 0; i < n; i++) s.reply.bulk(take());
      if (n === 0) return;
    }
    if (l.length === 0) this.keyspace.delete(args[1]);
    this.propagator.propagate(...args);
  }

  @Command('LLEN', { arity: 2 })
  llen(s: Session, args: string[]): void {
    const l = lookup(this.keyspace, s, args[1], isList);
    if (l !== WRONG_TYPE) s.reply.int(l?.length ?? 0);
  }

  @Command('LINDEX', { arity: 3 })
  lindex(s: Session, args: string[]): void {
    let i = parseIndex(args[2]);
    if (i === null) {
      s.reply.error(ERR_NOT_INT);
      return;
    }
    const l = lookup(this.keyspace, s, args[1], isList);
    if (l === WRONG_TYPE) return;
    if (l === undefined) {
      s.reply.null();
      return;
    }
    if (i < 0) i += l.length;
    if (i < 0 || i >= l.length) s.reply.null();
    else s.reply.bulk(l.at(i));
  }

  @Command('LRANGE', { arity: 4 })
  lrange(s: Session, args: string[]): void {
    const start = parseIndex(args[2]);
    const stop = parseIndex(args[3]);
    if (start === null || stop === null) {
      s.reply.error(ERR_NOT_INT);
      return;
    }
    const l = lookup(this.keyspace, s, args[1], isList);
    if (l === WRONG_TYPE) return;
    const range =
      l === undefined ? null : normalizeRange(start, stop, l.length);
    if (l === undefined || range === null) {
      s.reply.array(0);
      return;
    }
    const [from, to] = range;
    s.reply.array(to - from + 1);
    for (let i = from; i <= to; i++) s.reply.bulk(l.at(i));
  }

  @Command('LSET', { arity: 4, write: true })
  lset(s: Session, args: string[]): void {
    let i = parseIndex(args[2]);
    if (i === null) {
      s.reply.error(ERR_NOT_INT);
      return;
    }
    const l = lookup(this.keyspace, s, args[1], isList);
    if (l === WRONG_TYPE) return;
    if (l === undefined) {
      s.reply.error(ERR_NO_KEY);
      return;
    }
    if (i < 0) i += l.length;
    if (i < 0 || i >= l.length) {
      s.reply.error('ERR index out of range');
      return;
    }
    l.set(i, args[3]);
    this.propagator.propagate(...args);
    s.reply.simple('OK');
  }

  @Command('LTRIM', { arity: 4, write: true })
  ltrim(s: Session, args: string[]): void {
    const start = parseIndex(args[2]);
    const stop = parseIndex(args[3]);
    if (start === null || stop === null) {
      s.reply.error(ERR_NOT_INT);
      return;
    }
    const l = lookup(this.keyspace, s, args[1], isList);
    if (l === WRONG_TYPE) return;
    if (l === undefined) {
      s.reply.simple('OK');
      return;
    }
    const range = normalizeRange(start, stop, l.length);
    if (range === null) this.keyspace.delete(args[1]);
    else l.trim(range[0], range[1]);
    this.propagator.propagate(...args);
    s.reply.simple('OK');
  }
}
