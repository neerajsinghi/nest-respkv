import { Deque, normalizeRange } from './deque.js';
import { ExpiryIndex } from './expiry-index.js';
import { globMatch } from './glob.js';
import { IndexedSet } from './indexed-set.js';
import { ZSet } from './zset.js';

/** A small seeded generator, so a failing model test can be replayed. */
function rng(seed: number): (n: number) => number {
  let x = seed >>> 0 || 1;
  return (n) => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) % n;
  };
}

describe('Deque', () => {
  it('matches an array under random operations', () => {
    const r = rng(7);
    const d = new Deque<number>();
    const model: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      switch (r(6)) {
        case 0:
          d.pushFront(i);
          model.unshift(i);
          break;
        case 1:
        case 2:
          d.pushBack(i);
          model.push(i);
          break;
        case 3:
          expect(d.popFront()).toBe(model.shift());
          break;
        case 4:
          expect(d.popBack()).toBe(model.pop());
          break;
        case 5:
          if (model.length > 0 && r(50) === 0) {
            const range = normalizeRange(r(10) - 5, r(40) - 5, model.length);
            if (range !== null) {
              d.trim(range[0], range[1]);
              model.splice(
                0,
                model.length,
                ...model.slice(range[0], range[1] + 1),
              );
            }
          } else if (model.length > 0) {
            const at = r(model.length);
            d.set(at, -i);
            model[at] = -i;
          }
      }
      expect(d.length).toBe(model.length);
    }
    expect(Array.from({ length: d.length }, (_, i) => d.at(i))).toEqual(model);
  });
});

describe('normalizeRange', () => {
  it.each([
    [0, -1, 3, [0, 2]],
    [-2, -1, 3, [1, 2]],
    [-100, 100, 3, [0, 2]],
    [2, 1, 3, null],
    [5, 10, 3, null],
    [0, -4, 3, null],
    [0, 0, 0, null],
  ])('(%d, %d) of %d', (start, stop, n, want) => {
    expect(normalizeRange(start, stop, n)).toEqual(want);
  });
});

describe('ZSet', () => {
  it('matches a sorted array under random operations', () => {
    const r = rng(42);
    const z = new ZSet();
    const model = new Map<string, number>();
    const sorted = () =>
      [...model].sort(
        ([am, as], [bm, bs]) => as - bs || (am < bm ? -1 : am > bm ? 1 : 0),
      );
    for (let i = 0; i < 5000; i++) {
      const member = `m${r(300)}`;
      if (r(4) === 0) {
        expect(z.remove(member)).toBe(model.delete(member));
      } else {
        const score = r(50) - 25;
        expect(z.add(member, score)).toBe(!model.has(member));
        model.set(member, score);
      }
      if (i % 250 !== 0) continue;
      const want = sorted();
      expect(z.size).toBe(want.length);
      const got: [string, number][] = [];
      z.range(0, z.size - 1, (m, s) => got.push([m, s]));
      expect(got).toEqual(want);
      want.forEach(([m], rank) => expect(z.rank(m)).toBe(rank));
      const rev: string[] = [];
      z.rangeReverse(0, z.size - 1, (m) => rev.push(m));
      expect(rev).toEqual(want.map(([m]) => m).reverse());
      const inRange: string[] = [];
      z.rangeByScore(
        { score: -5, exclusive: true },
        { score: 5, exclusive: false },
        (m) => {
          inRange.push(m);
          return true;
        },
      );
      expect(inRange).toEqual(
        want.filter(([, s]) => s > -5 && s <= 5).map(([m]) => m),
      );
    }
  });

  it('orders equal scores bytewise by member', () => {
    const z = new ZSet();
    for (const m of ['b', 'a', '\xff', 'B', '']) z.add(m, 1);
    const got: string[] = [];
    z.range(0, 4, (m) => got.push(m));
    expect(got).toEqual(['', 'B', 'a', 'b', '\xff']);
  });
});

describe('IndexedSet and ExpiryIndex', () => {
  it('keep membership right through swap-removal', () => {
    const set = new IndexedSet<string>();
    const exp = new ExpiryIndex();
    const model = new Map<string, number>();
    const r = rng(3);
    for (let i = 0; i < 10_000; i++) {
      const k = `k${r(100)}`;
      if (r(3) === 0) {
        expect(set.delete(k)).toBe(model.has(k));
        exp.delete(k);
        model.delete(k);
      } else {
        expect(set.add(k)).toBe(!model.has(k));
        exp.set(k, i + 1);
        model.set(k, i + 1);
      }
    }
    expect(set.size).toBe(model.size);
    expect(exp.size).toBe(model.size);
    expect(new Set(set)).toEqual(new Set(model.keys()));
    for (const [k, at] of model) expect(exp.get(k)).toBe(at);
    expect(model.has(set.random() as string)).toBe(true);
    expect(model.has(exp.randomKey() as string)).toBe(true);
  });
});

describe('globMatch', () => {
  it.each([
    ['*', '', true],
    ['a*', 'abc', true],
    ['a*c', 'abbbc', true],
    ['a*c', 'abbb', false],
    ['?', 'x', true],
    ['?', '', false],
    ['[a-c]', 'b', true],
    ['[c-a]', 'b', true],
    ['[^a]', 'a', false],
    ['[^a]', 'b', true],
    ['\\*', '*', true],
    ['\\*', 'x', false],
    ['h[\\]]llo', 'h]llo', true],
  ])('%j matches %j: %s', (pattern, s, want) => {
    expect(globMatch(pattern, s)).toBe(want);
  });
});
