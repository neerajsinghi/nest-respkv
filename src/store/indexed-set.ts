/**
 * A set that can also return a uniformly random member in O(1), which a JS Set
 * can't: its only access is iteration from the start. Members live in an
 * array, and a map records each one's position so removal can swap the last
 * member into the gap.
 *
 * It backs the SET type, where SPOP needs a random member.
 */
export class IndexedSet<T> implements Iterable<T> {
  private items: T[] = [];
  private index = new Map<T, number>();

  get size(): number {
    return this.items.length;
  }

  has(v: T): boolean {
    return this.index.has(v);
  }

  /** Adds v and reports whether it was new. */
  add(v: T): boolean {
    if (this.index.has(v)) return false;
    this.index.set(v, this.items.length);
    this.items.push(v);
    return true;
  }

  /** Removes v and reports whether it was present. */
  delete(v: T): boolean {
    const i = this.index.get(v);
    if (i === undefined) return false;
    const last = this.items.pop() as T;
    this.index.delete(v);
    if (i < this.items.length) {
      this.items[i] = last;
      this.index.set(last, i);
    }
    return true;
  }

  random(): T | undefined {
    if (this.items.length === 0) return undefined;
    return this.items[Math.floor(Math.random() * this.items.length)];
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]();
  }
}
