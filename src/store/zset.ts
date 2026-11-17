const MAX_LEVEL = 32;
const P = 0.25;

interface ZNode {
  member: string;
  score: number;
  prev: ZNode | null;
  next: (ZNode | null)[];
  /** span[i] is how many elements next[i] jumps over. */
  span: number[];
}

/** One end of a score range. */
export interface ScoreBound {
  score: number;
  exclusive: boolean;
}

function belowMin(b: ScoreBound, score: number): boolean {
  return score < b.score || (b.exclusive && score === b.score);
}

function aboveMax(b: ScoreBound, score: number): boolean {
  return score > b.score || (b.exclusive && score === b.score);
}

function before(n: ZNode, score: number, member: string): boolean {
  return n.score < score || (n.score === score && n.member < member);
}

function randomLevel(): number {
  let level = 1;
  while (level < MAX_LEVEL && Math.random() < P) level++;
  return level;
}

function newNode(member: string, score: number, level: number): ZNode {
  return {
    member,
    score,
    prev: null,
    next: new Array<ZNode | null>(level).fill(null),
    span: new Array<number>(level).fill(0),
  };
}

/**
 * A sorted set: a map for O(1) score lookup plus a skip list ordered by
 * (score, member). Each link records its span, the number of elements it jumps
 * over, so finding a member's rank or the element at a rank is O(log n) too.
 * This is the same structure Redis uses.
 *
 * Members compare as latin1 strings, so `<` orders them bytewise, as Redis's
 * memcmp does.
 */
export class ZSet {
  private scores = new Map<string, number>();
  private head = newNode('', 0, MAX_LEVEL);
  private tail: ZNode | null = null;
  private level = 1;
  private len = 0;

  get size(): number {
    return this.len;
  }

  score(member: string): number | undefined {
    return this.scores.get(member);
  }

  /** Inserts member or updates its score, and reports whether it was new. */
  add(member: string, score: number): boolean {
    const old = this.scores.get(member);
    if (old !== undefined) {
      if (old === score) return false;
      this.unlink(old, member);
    }
    this.scores.set(member, score);
    this.insert(score, member);
    return old === undefined;
  }

  /** Removes member and reports whether it was present. */
  remove(member: string): boolean {
    const score = this.scores.get(member);
    if (score === undefined) return false;
    this.scores.delete(member);
    this.unlink(score, member);
    return true;
  }

  private insert(score: number, member: string): void {
    const update = new Array<ZNode>(MAX_LEVEL);
    const rank = new Array<number>(MAX_LEVEL).fill(0);

    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      if (i < this.level - 1) rank[i] = rank[i + 1];
      for (
        let n = x.next[i];
        n !== null && before(n, score, member);
        n = x.next[i]
      ) {
        rank[i] += x.span[i];
        x = n;
      }
      update[i] = x;
    }

    const level = randomLevel();
    if (level > this.level) {
      for (let i = this.level; i < level; i++) {
        rank[i] = 0;
        update[i] = this.head;
        this.head.span[i] = this.len;
      }
      this.level = level;
    }

    const n = newNode(member, score, level);
    for (let i = 0; i < level; i++) {
      n.next[i] = update[i].next[i];
      update[i].next[i] = n;
      n.span[i] = update[i].span[i] - (rank[0] - rank[i]);
      update[i].span[i] = rank[0] - rank[i] + 1;
    }
    for (let i = level; i < this.level; i++) update[i].span[i]++;

    n.prev = update[0] === this.head ? null : update[0];
    const after = n.next[0];
    if (after !== null) after.prev = n;
    else this.tail = n;
    this.len++;
  }

  private unlink(score: number, member: string): void {
    const update = new Array<ZNode>(MAX_LEVEL);
    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      for (
        let n = x.next[i];
        n !== null && before(n, score, member);
        n = x.next[i]
      ) {
        x = n;
      }
      update[i] = x;
    }
    const target = x.next[0];
    if (target === null || target.member !== member) return;
    for (let i = 0; i < this.level; i++) {
      if (update[i].next[i] === target) {
        update[i].span[i] += target.span[i] - 1;
        update[i].next[i] = target.next[i];
      } else {
        update[i].span[i]--;
      }
    }
    const after = target.next[0];
    if (after !== null) after.prev = target.prev;
    else this.tail = target.prev;
    while (this.level > 1 && this.head.next[this.level - 1] === null)
      this.level--;
    this.len--;
  }

  /** Returns member's zero-based position by ascending (score, member). */
  rank(member: string): number | undefined {
    const score = this.scores.get(member);
    if (score === undefined) return undefined;
    let rank = 0;
    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      for (
        let n = x.next[i];
        n !== null && (before(n, score, member) || n.member === member);
        n = x.next[i]
      ) {
        rank += x.span[i];
        x = n;
      }
      if (x !== this.head && x.member === member) return rank - 1;
    }
    return undefined;
  }

  private nodeAt(rank: number): ZNode | null {
    let remaining = rank + 1;
    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      while (x.next[i] !== null && x.span[i] <= remaining) {
        remaining -= x.span[i];
        x = x.next[i] as ZNode;
      }
      if (remaining === 0) return x;
    }
    return null;
  }

  /** Calls fn for ranks from..to inclusive, in ascending order. */
  range(
    from: number,
    to: number,
    fn: (member: string, score: number) => void,
  ): void {
    let n = this.nodeAt(from);
    for (let i = from; i <= to && n !== null; i++) {
      fn(n.member, n.score);
      n = n.next[0];
    }
  }

  /** Calls fn for positions from..to counted from the highest score. */
  rangeReverse(
    from: number,
    to: number,
    fn: (member: string, score: number) => void,
  ): void {
    let n = this.nodeAt(this.len - 1 - from);
    for (let i = from; i <= to && n !== null; i++) {
      fn(n.member, n.score);
      n = n.prev;
    }
  }

  /**
   * Calls fn for members with scores within [lo, hi] in ascending order, until
   * fn returns false.
   */
  rangeByScore(
    lo: ScoreBound,
    hi: ScoreBound,
    fn: (member: string, score: number) => boolean,
  ): void {
    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      for (
        let n = x.next[i];
        n !== null && belowMin(lo, n.score);
        n = x.next[i]
      ) {
        x = n;
      }
    }
    for (
      let n = x.next[0];
      n !== null && !aboveMax(hi, n.score);
      n = n.next[0]
    ) {
      if (!fn(n.member, n.score)) return;
    }
  }
}
