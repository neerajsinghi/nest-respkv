import { Session } from '../engine/session.js';
import { Deque } from '../store/deque.js';
import { IndexedSet } from '../store/indexed-set.js';
import { HashValue, Keyspace, Value } from '../store/keyspace.js';
import { ZSet } from '../store/zset.js';

export const ERR_WRONG_TYPE =
  'WRONGTYPE Operation against a key holding the wrong kind of value';
export const ERR_SYNTAX = 'ERR syntax error';
export const ERR_NOT_INT = 'ERR value is not an integer or out of range';
export const ERR_NOT_FLOAT = 'ERR value is not a valid float';
export const ERR_NO_KEY = 'ERR no such key';

/** Returned by lookups when the key holds another type; the error is already written. */
export const WRONG_TYPE: unique symbol = Symbol('WRONGTYPE');

export const isString = (v: Value): v is string => typeof v === 'string';
export const isList = (v: Value): v is Deque<string> => v instanceof Deque;
export const isHash = (v: Value): v is HashValue => v instanceof Map;
export const isSet = (v: Value): v is IndexedSet<string> =>
  v instanceof IndexedSet;
export const isZSet = (v: Value): v is ZSet => v instanceof ZSet;

/**
 * Fetches key as the type `is` accepts. When the key holds another type it
 * writes the WRONGTYPE reply and returns WRONG_TYPE, so handlers just return.
 */
export function lookup<T extends Value>(
  ks: Keyspace,
  s: Session,
  key: string,
  is: (v: Value) => v is T,
): T | undefined | typeof WRONG_TYPE {
  const v = ks.get(key);
  if (v === undefined) return undefined;
  if (!is(v)) {
    s.reply.error(ERR_WRONG_TYPE);
    return WRONG_TYPE;
  }
  return v;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INTEGER = /^(?:0|-?[1-9][0-9]{0,18})$/;

/**
 * Parses a signed 64-bit integer as strictly as Redis does: no plus sign, no
 * leading zeros, no spaces.
 */
export function parseInt64(s: string): bigint | null {
  if (!INTEGER.test(s)) return null;
  const v = BigInt(s);
  return v < INT64_MIN || v > INT64_MAX ? null : v;
}

/**
 * Parses an integer argument used as an index or count. Precision beyond 2^53
 * doesn't matter there, because such values only ever get clamped.
 */
export function parseIndex(s: string): number | null {
  const v = parseInt64(s);
  return v === null ? null : Number(v);
}

/** Reports whether v + d stays within a signed 64-bit integer. */
export function addFits(v: bigint, d: bigint): boolean {
  const sum = v + d;
  return sum >= INT64_MIN && sum <= INT64_MAX;
}

const FLOAT =
  /^[+-]?(?:(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|inf(?:inity)?)$/i;

/**
 * Parses a float as Redis does: decimal or exponent forms and inf, with no
 * spaces. NaN is refused, because it has no place in an ordering.
 */
export function parseFloat64(s: string): number | null {
  if (!FLOAT.test(s)) return null;
  const lower = s.toLowerCase();
  if (lower.endsWith('inf') || lower.endsWith('infinity')) {
    return s[0] === '-' ? -Infinity : Infinity;
  }
  return Number(s);
}

/**
 * Formats a score for a reply: the shortest text that parses back to the same
 * number. Integral values below 1e17 have no exponent, as in Redis. Otherwise
 * the layout is Go's %g with shortest precision, so an AOF rewritten here is
 * byte-for-byte what go-respkv writes: an exponent below 1e-4 or from 1e6 up,
 * with at least two exponent digits.
 */
export function formatScore(f: number): string {
  if (f === Infinity) return 'inf';
  if (f === -Infinity) return '-inf';
  if (Object.is(f, -0)) return '-0';
  if (Number.isInteger(f) && Math.abs(f) < 1e17) return f.toFixed(0);
  const [mantissa, e] = f.toExponential().split('e');
  const exp = Number(e);
  if (exp < -4 || exp >= 6) {
    return `${mantissa}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return String(f);
}

/** Case-insensitive comparison against an upper-case keyword. */
export function is(arg: string, keyword: string): boolean {
  return arg.length === keyword.length && arg.toUpperCase() === keyword;
}
