/**
 * Expiry times of the keys that have one, keyed by key, with O(1) random
 * sampling for active expiry. Same layout as IndexedSet, plus a parallel array
 * of times, so there's no object per key.
 */
export class ExpiryIndex {
  private keys: string[] = [];
  private times: number[] = [];
  private index = new Map<string, number>();

  get size(): number {
    return this.keys.length;
  }

  /** Returns key's expiry in unix milliseconds, or 0 if it has none. */
  get(key: string): number {
    const i = this.index.get(key);
    return i === undefined ? 0 : this.times[i];
  }

  set(key: string, at: number): void {
    const i = this.index.get(key);
    if (i !== undefined) {
      this.times[i] = at;
      return;
    }
    this.index.set(key, this.keys.length);
    this.keys.push(key);
    this.times.push(at);
  }

  delete(key: string): void {
    const i = this.index.get(key);
    if (i === undefined) return;
    const lastKey = this.keys.pop() as string;
    const lastTime = this.times.pop() as number;
    this.index.delete(key);
    if (i < this.keys.length) {
      this.keys[i] = lastKey;
      this.times[i] = lastTime;
      this.index.set(lastKey, i);
    }
  }

  randomKey(): string | undefined {
    if (this.keys.length === 0) return undefined;
    return this.keys[Math.floor(Math.random() * this.keys.length)];
  }

  clear(): void {
    this.keys = [];
    this.times = [];
    this.index = new Map();
  }
}
