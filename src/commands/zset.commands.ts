import { Injectable } from '@nestjs/common';
import { Command } from '../engine/command.decorator.js';
import { Session } from '../engine/session.js';
import { Propagator } from '../persistence/propagator.js';
import { normalizeRange } from '../store/deque.js';
import { Keyspace } from '../store/keyspace.js';
import { ScoreBound, ZSet } from '../store/zset.js';
import {
  ERR_NOT_FLOAT,
  ERR_NOT_INT,
  ERR_SYNTAX,
  formatScore,
  is,
  isZSet,
  lookup,
  parseFloat64,
  parseIndex,
  WRONG_TYPE,
} from './common.js';

function parseBound(arg: string): ScoreBound | null {
  const exclusive = arg.startsWith('(');
  const score = parseFloat64(exclusive ? arg.slice(1) : arg);
  return score === null ? null : { score, exclusive };
}

@Injectable()
export class ZSetCommands {
  constructor(
    private readonly keyspace: Keyspace,
    private readonly propagator: Propagator,
  ) {}

  /** ZADD key [NX|XX] [CH] score member [score member ...] */
  @Command('ZADD', { arity: -4, write: true })
  zadd(s: Session, args: string[]): void {
    let nx = false;
    let xx = false;
    let ch = false;
    let i = 2;
    for (; i < args.length; i++) {
      const opt = args[i].toUpperCase();
      if (opt === 'NX') nx = true;
      else if (opt === 'XX') xx = true;
      else if (opt === 'CH') ch = true;
      else break;
    }
    const pairs = args.length - i;
    if (pairs === 0 || pairs % 2 !== 0 || (nx && xx)) {
      s.reply.error(ERR_SYNTAX);
      return;
    }
    const scores: number[] = [];
    for (let j = i; j < args.length; j += 2) {
      const f = parseFloat64(args[j]);
      if (f === null) {
        s.reply.error(ERR_NOT_FLOAT);
        return;
      }
      scores.push(f);
    }
    let z = lookup(this.keyspace, s, args[1], isZSet);
    if (z === WRONG_TYPE) return;
    if (z === undefined) {
      if (xx) {
        s.reply.int(0);
        return;
      }
      z = new ZSet();
      this.keyspace.put(args[1], z);
    }
    let added = 0;
    let changed = 0;
    for (let j = 0; j < scores.length; j++) {
      const member = args[i + 2 * j + 1];
      const old = z.score(member);
      if ((old !== undefined && nx) || (old === undefined && xx)) continue;
      if (z.add(member, scores[j])) added++;
      else if (old !== scores[j]) changed++;
    }
    if (added + changed > 0) this.propagator.propagate(...args);
    s.reply.int(ch ? added + changed : added);
  }

  @Command('ZREM', { arity: -3, write: true })
  zrem(s: Session, args: string[]): void {
    const z = lookup(this.keyspace, s, args[1], isZSet);
    if (z === WRONG_TYPE) return;
    let removed = 0;
    for (let i = 2; z !== undefined && i < args.length; i++) {
      if (z.remove(args[i])) removed++;
    }
    if (removed > 0) {
      if (z?.size === 0) this.keyspace.delete(args[1]);
      this.propagator.propagate(...args);
    }
    s.reply.int(removed);
  }

  @Command('ZSCORE', { arity: 3 })
  zscore(s: Session, args: string[]): void {
    const z = lookup(this.keyspace, s, args[1], isZSet);
    if (z === WRONG_TYPE) return;
    const score = z?.score(args[2]);
    if (score === undefined) s.reply.null();
    else s.reply.bulk(formatScore(score));
  }

  @Command('ZCARD', { arity: 2 })
  zcard(s: Session, args: string[]): void {
    const z = lookup(this.keyspace, s, args[1], isZSet);
    if (z !== WRONG_TYPE) s.reply.int(z?.size ?? 0);
  }

  @Command('ZRANK', { arity: 3 })
  zrank(s: Session, args: string[]): void {
    const z = lookup(this.keyspace, s, args[1], isZSet);
    if (z === WRONG_TYPE) return;
    const rank = z?.rank(args[2]);
    if (rank === undefined) s.reply.null();
    else s.reply.int(rank);
  }

  @Command('ZINCRBY', { arity: 4, write: true })
  zincrby(s: Session, args: string[]): void {
    const d = parseFloat64(args[2]);
    if (d === null) {
      s.reply.error(ERR_NOT_FLOAT);
      return;
    }
    let z = lookup(this.keyspace, s, args[1], isZSet);
    if (z === WRONG_TYPE) return;
    const next = (z?.score(args[3]) ?? 0) + d;
    if (Number.isNaN(next)) {
      // inf + -inf
      s.reply.error('ERR resulting score is not a number (NaN)');
      return;
    }
    if (z === undefined) {
      z = new ZSet();
      this.keyspace.put(args[1], z);
    }
    z.add(args[3], next);
    this.propagator.propagate(...args);
    s.reply.bulk(formatScore(next));
  }

  @Command('ZRANGE', { arity: -4 })
  zrange(s: Session, args: string[]): void {
    this.range(s, args, false);
  }

  @Command('ZREVRANGE', { arity: -4 })
  zrevrange(s: Session, args: string[]): void {
    this.range(s, args, true);
  }

  /** By rank only: no BYSCORE, BYLEX or REV options. */
  private range(s: Session, args: string[], reverse: boolean): void {
    const start = parseIndex(args[2]);
    const stop = parseIndex(args[3]);
    let withScores = false;
    if (args.length === 5 && is(args[4], 'WITHSCORES')) withScores = true;
    else if (args.length > 4) {
      s.reply.error(ERR_SYNTAX);
      return;
    }
    if (start === null || stop === null) {
      s.reply.error(ERR_NOT_INT);
      return;
    }
    const z = lookup(this.keyspace, s, args[1], isZSet);
    if (z === WRONG_TYPE) return;
    const range = z === undefined ? null : normalizeRange(start, stop, z.size);
    if (z === undefined || range === null) {
      s.reply.array(0);
      return;
    }
    const [from, to] = range;
    s.reply.array((to - from + 1) * (withScores ? 2 : 1));
    const emit = (member: string, score: number): void => {
      s.reply.bulk(member);
      if (withScores) s.reply.bulk(formatScore(score));
    };
    if (reverse) z.rangeReverse(from, to, emit);
    else z.range(from, to, emit);
  }

  /** ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT offset count] */
  @Command('ZRANGEBYSCORE', { arity: -4 })
  zrangebyscore(s: Session, args: string[]): void {
    const lo = parseBound(args[2]);
    const hi = parseBound(args[3]);
    if (lo === null || hi === null) {
      s.reply.error('ERR min or max is not a float');
      return;
    }
    let withScores = false;
    let offset = 0;
    let limit = -1;
    for (let i = 4; i < args.length; i++) {
      if (is(args[i], 'WITHSCORES')) {
        withScores = true;
      } else if (is(args[i], 'LIMIT') && i + 2 < args.length) {
        const o = parseIndex(args[i + 1]);
        const l = parseIndex(args[i + 2]);
        if (o === null || l === null) {
          s.reply.error(ERR_NOT_INT);
          return;
        }
        offset = o;
        limit = l;
        i += 2;
      } else {
        s.reply.error(ERR_SYNTAX);
        return;
      }
    }
    const z = lookup(this.keyspace, s, args[1], isZSet);
    if (z === WRONG_TYPE) return;
    const out: string[] = [];
    if (z !== undefined && offset >= 0) {
      z.rangeByScore(lo, hi, (member, score) => {
        if (offset > 0) {
          offset--;
          return true;
        }
        if (limit === 0) return false;
        limit--;
        out.push(member);
        if (withScores) out.push(formatScore(score));
        return true;
      });
    }
    s.reply.array(out.length);
    for (const v of out) s.reply.bulk(v);
  }
}
