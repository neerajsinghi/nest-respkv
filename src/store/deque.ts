/**
 * A double-ended queue on a ring buffer, the value behind the LIST type. Push
 * and pop at either end and access by index are all O(1). A plain array would
 * make LPUSH and LPOP O(n), since unshift and shift move every element.
 */
export class Deque<T> {
  private ring: (T | undefined)[] = new Array<T | undefined>(8);
  private head = 0;
  private len = 0;

  get length(): number {
    return this.len;
  }

  pushFront(v: T): void {
    this.grow();
    this.head = (this.head - 1) & (this.ring.length - 1);
    this.ring[this.head] = v;
    this.len++;
  }

  pushBack(v: T): void {
    this.grow();
    this.ring[(this.head + this.len) & (this.ring.length - 1)] = v;
    this.len++;
  }

  popFront(): T | undefined {
    if (this.len === 0) return undefined;
    const v = this.ring[this.head];
    this.ring[this.head] = undefined;
    this.head = (this.head + 1) & (this.ring.length - 1);
    this.len--;
    this.shrink();
    return v;
  }

  popBack(): T | undefined {
    if (this.len === 0) return undefined;
    const i = (this.head + this.len - 1) & (this.ring.length - 1);
    const v = this.ring[i];
    this.ring[i] = undefined;
    this.len--;
    this.shrink();
    return v;
  }

  /** Returns the element at i, which must be in [0, length). */
  at(i: number): T {
    return this.ring[(this.head + i) & (this.ring.length - 1)] as T;
  }

  set(i: number, v: T): void {
    this.ring[(this.head + i) & (this.ring.length - 1)] = v;
  }

  /** Keeps only the elements in [from, to]. */
  trim(from: number, to: number): void {
    const kept: (T | undefined)[] = [];
    for (let i = from; i <= to; i++) kept.push(this.at(i));
    this.resetTo(kept);
  }

  private resetTo(items: (T | undefined)[]): void {
    let cap = 8;
    while (cap < items.length) cap *= 2;
    this.ring = items.concat(new Array<T | undefined>(cap - items.length));
    this.head = 0;
    this.len = items.length;
  }

  private grow(): void {
    if (this.len < this.ring.length) return;
    const items: (T | undefined)[] = [];
    for (let i = 0; i < this.len; i++) items.push(this.at(i));
    this.ring = items.concat(new Array<T | undefined>(this.ring.length));
    this.head = 0;
  }

  /** Halves the ring when it's mostly empty, so a drained list frees memory. */
  private shrink(): void {
    if (this.ring.length > 64 && this.len < this.ring.length / 4) {
      const items: (T | undefined)[] = [];
      for (let i = 0; i < this.len; i++) items.push(this.at(i));
      this.resetTo(items);
    }
  }
}

/**
 * Turns Redis's start/stop indexes, where negative counts from the end, into
 * an inclusive range within [0, n). Returns null when the range is empty.
 */
export function normalizeRange(
  start: number,
  stop: number,
  n: number,
): [number, number] | null {
  if (start < 0) start = Math.max(start + n, 0);
  if (stop < 0) stop += n;
  if (stop >= n) stop = n - 1;
  if (start > stop || start >= n || stop < 0) return null;
  return [start, stop];
}
