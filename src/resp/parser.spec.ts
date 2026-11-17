import { encodeCommand } from './reply-writer.js';
import {
  DEFAULT_LIMITS,
  Limits,
  parseCommand,
  ProtocolError,
  UNAUTH_LIMITS,
} from './parser.js';

function parse(input: string | Buffer, lim: Limits = DEFAULT_LIMITS) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'latin1') : input;
  return parseCommand(buf, 0, buf.length, lim);
}

describe('parseCommand', () => {
  it('parses an array command', () => {
    expect(parse('*2\r\n$3\r\nGET\r\n$1\r\nk\r\n')).toEqual({
      args: ['GET', 'k'],
      consumed: 20,
    });
  });

  it('returns null for every proper prefix of a command', () => {
    const cmd = '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$5\r\nvalue\r\n';
    for (let i = 0; i < cmd.length; i++) {
      expect(parse(cmd.slice(0, i))).toBeNull();
    }
    expect(parse(cmd)?.args).toEqual(['SET', 'k', 'value']);
  });

  it('parses only up to end, ignoring bytes after it', () => {
    const buf = Buffer.from('*1\r\n$4\r\nPING\r\nGARBAGE');
    expect(parseCommand(buf, 0, 14, DEFAULT_LIMITS)?.args).toEqual(['PING']);
    expect(parseCommand(buf, 0, 13, DEFAULT_LIMITS)).toBeNull();
  });

  it('round-trips every byte value', () => {
    const value = Buffer.from(
      Array.from({ length: 256 }, (_, i) => i),
    ).toString('latin1');
    const parsed = parse(encodeCommand(['SET', 'k', value]));
    expect(parsed?.args[2]).toBe(value);
    expect(Buffer.from(parsed?.args[2] ?? '', 'latin1')).toHaveLength(256);
  });

  it('parses inline commands', () => {
    expect(parse('SET  k\tv\r\n')).toEqual({
      args: ['SET', 'k', 'v'],
      consumed: 10,
    });
    expect(parse('PING\n')?.args).toEqual(['PING']);
    expect(parse('\r\n')).toEqual({ args: [], consumed: 2 });
    expect(parse('PING')).toBeNull();
  });

  it('treats an empty array as nothing', () => {
    expect(parse('*0\r\n')).toEqual({ args: [], consumed: 4 });
  });

  it.each([
    ['*x\r\n', 'invalid multibulk length'],
    ['*1\r\n:1\r\n', "expected '$'"],
    ['*1\r\n$-1\r\n', 'invalid bulk length'],
    ['*1\r\n$+1\r\na\r\n', 'invalid bulk length'],
    ['*1\r\n$1\r\nab\r\n', 'not terminated by CRLF'],
    ['*1\r\n$1\ra\r\n', 'expected CRLF'],
  ])('rejects %j', (input, message) => {
    expect(() => parse(input)).toThrow(ProtocolError);
    expect(() => parse(input)).toThrow(message);
  });

  it('applies limits before allocating', () => {
    expect(() => parse('*11\r\n', UNAUTH_LIMITS)).toThrow(
      'invalid multibulk length',
    );
    expect(() => parse(`*1\r\n$${16 * 1024 + 1}\r\n`, UNAUTH_LIMITS)).toThrow(
      'invalid bulk length',
    );
    expect(() => parse('*1\r\n$999999999999\r\n')).toThrow(
      'invalid bulk length',
    );
    // A huge count is accepted up to the limit but allocates nothing until
    // the whole command has arrived.
    expect(parse('*1048576\r\n')).toBeNull();
  });

  it('rejects a length line or inline command without an end', () => {
    expect(() => parse('*' + '1'.repeat(70 * 1024))).toThrow(
      'too big count string',
    );
    expect(() => parse('A'.repeat(70 * 1024))).toThrow(
      'too big inline request',
    );
  });
});
