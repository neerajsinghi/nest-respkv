import { formatScore, parseFloat64, parseInt64 } from './common.js';

describe('parseInt64', () => {
  it.each([
    ['0', 0n],
    ['-1', -1n],
    ['9223372036854775807', 9223372036854775807n],
    ['-9223372036854775808', -9223372036854775808n],
  ])('accepts %j', (s, want) => expect(parseInt64(s)).toBe(want));

  it.each([
    '',
    '+1',
    '01',
    '-0',
    ' 1',
    '1 ',
    '1.0',
    '9223372036854775808',
    '0x10',
    '1e3',
  ])('rejects %j as Redis does', (s) => expect(parseInt64(s)).toBeNull());
});

describe('parseFloat64', () => {
  it.each([
    ['1', 1],
    ['-2.5', -2.5],
    ['.5', 0.5],
    ['5.', 5],
    ['1e3', 1000],
    ['inf', Infinity],
    ['+INF', Infinity],
    ['-inf', -Infinity],
    ['-Infinity', -Infinity],
  ])('accepts %j', (s, want) => expect(parseFloat64(s)).toBe(want));

  it.each(['', 'nan', 'abc', ' 1', '1 ', '1e', '--1'])('rejects %j', (s) =>
    expect(parseFloat64(s)).toBeNull(),
  );
});

describe('formatScore', () => {
  it.each([
    [1, '1'],
    [-0, '-0'],
    [2.5, '2.5'],
    [0.1, '0.1'],
    [1e16, '10000000000000000'],
    [1e17, '1e+17'],
    [1234567.5, '1.2345675e+06'],
    [123456.5, '123456.5'],
    [0.0001, '0.0001'],
    [0.00001, '1e-05'],
    [-2.5e-300, '-2.5e-300'],
    [Infinity, 'inf'],
    [-Infinity, '-inf'],
  ])('formats %d as %j', (f, want) => expect(formatScore(f)).toBe(want));

  it('round-trips', () => {
    for (const f of [0.1 + 0.2, 1 / 3, 1e-300, 123456789.12345679]) {
      expect(Number(formatScore(f))).toBe(f);
    }
  });
});
