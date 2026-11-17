import { Injectable } from '@nestjs/common';
import { Deque } from './deque.js';
import { ExpiryIndex } from './expiry-index.js';
import { IndexedSet } from './indexed-set.js';
import { ZSet } from './zset.js';

/** A hash's fields and values. */
export type HashValue = Map<string, string>;

/**
 * What a key can hold. Strings, members and fields are all latin1 strings, one
 * character per byte, so they hold binary data unchanged.
 */
export type Value =
  string | Deque<string> | HashValue | IndexedSet<string> | ZSet;

export type TypeName = 'string' | 'list' | 'hash' | 'set' | 'zset';

export function typeName(v: Value): TypeName {
  if (typeof v === 'string') return 'string';
  if (v instanceof Deque) return 'list';
  if (v instanceof Map) return 'hash';
  if (v instanceof IndexedSet) return 'set';
  return 'zset';
}

/**
 * The keyspace: every key's value, plus expiry times for the keys that have
 * one, kept apart as Redis does so that keys without a TTL cost nothing extra.
 *
 * Nothing here is asynchronous. Commands run one at a time on the event loop,
 * which is what makes each command, and each MULTI/EXEC, atomic. See
 * docs/adr/0001-event-loop-execution.md.
 */
@Injectable()
export class Keyspace {
  private data = new Map<string, Value>();
  private expires = new ExpiryIndex();

  /** Current time in unix milliseconds. Tests replace it. */
  now: () => number = Date.now;

  /**
   * Called when a key is removed because its TTL passed, so the engine can
   * log a DEL. docs/DESIGN.md explains why expiry is logged.
   */
  onExpire: ((key: string) => void) | null = null;

  /**
   * Disables expiry while the AOF is replayed. The log already records every
   * key that expired as an explicit DEL, so deciding expiry again during
   * replay would change history.
   */
  loading = false;

  private isExpired(key: string): boolean {
    if (this.loading) return false;
    const at = this.expires.get(key);
    return at !== 0 && at <= this.now();
  }

  private expire(key: string): void {
    this.data.delete(key);
    this.expires.delete(key);
    this.onExpire?.(key);
  }

  /**
   * Returns key's value, or undefined. This is the lazy half of expiry: a key
   * past its TTL is removed here, so no caller ever sees an expired value.
   */
  get(key: string): Value | undefined {
    const v = this.data.get(key);
    if (v === undefined) return undefined;
    if (this.isExpired(key)) {
      this.expire(key);
      return undefined;
    }
    return v;
  }

  /** Sets key to value with the given expiry, replacing any existing entry. */
  put(key: string, value: Value, expireAt = 0): void {
    this.data.set(key, value);
    if (expireAt !== 0) this.expires.set(key, expireAt);
    else this.expires.delete(key);
  }

  /** Replaces the value of a live key, keeping its TTL. */
  replace(key: string, value: Value): void {
    this.data.set(key, value);
  }

  /** Removes key and reports whether a live key was removed. */
  delete(key: string): boolean {
    if (this.get(key) === undefined) return false;
    this.data.delete(key);
    this.expires.delete(key);
    return true;
  }

  /** Returns key's expiry in unix milliseconds, or 0 if it has none. */
  expireAt(key: string): number {
    return this.get(key) === undefined ? 0 : this.expires.get(key);
  }

  /** Sets a live key's expiry and reports whether the key exists. */
  setExpire(key: string, at: number): boolean {
    if (this.get(key) === undefined) return false;
    this.expires.set(key, at);
    return true;
  }

  /** Clears key's expiry and reports whether there was one to clear. */
  persist(key: string): boolean {
    if (this.get(key) === undefined || this.expires.get(key) === 0)
      return false;
    this.expires.delete(key);
    return true;
  }

  /**
   * Moves src to dst, keeping src's TTL and replacing dst. Reports whether src
   * exists.
   */
  rename(src: string, dst: string): boolean {
    const v = this.get(src);
    if (v === undefined) return false;
    if (src === dst) return true;
    const at = this.expires.get(src);
    this.data.delete(src);
    this.expires.delete(src);
    this.put(dst, v, at);
    return true;
  }

  /** Number of keys, including expired keys not yet collected, as in Redis. */
  get size(): number {
    return this.data.size;
  }

  get volatileSize(): number {
    return this.expires.size;
  }

  flush(): void {
    this.data = new Map();
    this.expires.clear();
  }

  /** Every live key with its value and expiry. Don't modify keys while iterating. */
  *entries(): IterableIterator<[string, Value, number]> {
    for (const [key, value] of this.data) {
      if (!this.isExpired(key)) yield [key, value, this.expires.get(key)];
    }
  }

  /**
   * Checks up to `sample` random keys that have a TTL and removes the expired
   * ones. This is the active half of expiry, reclaiming keys nobody reads.
   */
  activeExpire(sample: number): { checked: number; expired: number } {
    let checked = 0;
    let expired = 0;
    const n = Math.min(sample, this.expires.size);
    for (; checked < n; checked++) {
      const key = this.expires.randomKey() as string;
      if (this.isExpired(key)) {
        this.expire(key);
        expired++;
      }
    }
    return { checked, expired };
  }
}
