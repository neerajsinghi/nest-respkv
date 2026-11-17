import { constants } from 'node:buffer';

/**
 * Limits bound what the parser accepts, so a client cannot make the server
 * allocate memory just by announcing a large command.
 */
export interface Limits {
  /** Elements in one command array. */
  maxArgs: number;
  /** Bytes in one argument. */
  maxBulk: number;
  /** Bytes in one inline command or length line. */
  maxInline: number;
}

/**
 * Matches Redis's limits, except that one argument can't exceed V8's longest
 * string, which is 24 bytes short of Redis's 512 MiB.
 */
export const DEFAULT_LIMITS: Limits = {
  maxArgs: 1024 * 1024,
  maxBulk: Math.min(512 * 1024 * 1024, constants.MAX_STRING_LENGTH),
  maxInline: 64 * 1024,
};

/** Applies until a connection has authenticated. */
export const UNAUTH_LIMITS: Limits = {
  maxArgs: 10,
  maxBulk: 16 * 1024,
  maxInline: 16 * 1024,
};

/**
 * The stream is not valid RESP. It can't be resynchronised after this, so the
 * connection has to be closed.
 */
export class ProtocolError extends Error {
  constructor(detail: string) {
    super(`Protocol error: ${detail}`);
  }
}

export interface Parsed {
  /**
   * Arguments as latin1 strings: one character per byte, so binary data
   * survives unchanged. Empty for a blank line or an empty array.
   */
  args: string[];
  /** Bytes consumed from the input. */
  consumed: number;
}

const CR = 13;
const LF = 10;

/**
 * Reads one command from buf[pos, end). Returns null when the command is not
 * complete yet; the caller should wait for more input and call again.
 *
 * Nothing is allocated until the whole command has arrived. The first pass only
 * validates and finds the end, so a retry on partial input is cheap and
 * `*1000000` costs nothing up front.
 */
export function parseCommand(
  buf: Buffer,
  pos: number,
  end: number,
  lim: Limits,
): Parsed | null {
  if (pos >= end) return null;
  if (buf[pos] !== 0x2a /* '*' */) return parseInline(buf, pos, end, lim);

  const header = readLine(buf, pos, end, lim);
  if (header < 0) return null;
  const count = parseLength(buf, pos + 1, header);
  if (count === null || count > lim.maxArgs) {
    throw new ProtocolError('invalid multibulk length');
  }
  let p = header + 2;
  if (count <= 0) return { args: [], consumed: p - pos };

  const first = p;
  for (let i = 0; i < count; i++) {
    if (p >= end) return null;
    if (buf[p] !== 0x24 /* '$' */) {
      throw new ProtocolError(
        `expected '$', got '${String.fromCharCode(buf[p])}'`,
      );
    }
    const line = readLine(buf, p, end, lim);
    if (line < 0) return null;
    const size = parseLength(buf, p + 1, line);
    if (size === null || size < 0 || size > lim.maxBulk) {
      throw new ProtocolError('invalid bulk length');
    }
    const stop = line + 2 + size + 2;
    if (stop > end) return null;
    if (buf[stop - 2] !== CR || buf[stop - 1] !== LF) {
      throw new ProtocolError('bulk string not terminated by CRLF');
    }
    p = stop;
  }

  // The command is complete and valid, so copy the arguments out.
  const args = new Array<string>(count);
  let q = first;
  for (let i = 0; i < count; i++) {
    const line = buf.indexOf(CR, q);
    const size = parseLength(buf, q + 1, line) as number;
    const start = line + 2;
    args[i] = buf.toString('latin1', start, start + size);
    q = start + size + 2;
  }
  return { args, consumed: p - pos };
}

/**
 * The human-typed form, `SET key value\r\n`. Unlike Redis it doesn't interpret
 * quotes; every real client uses the array form.
 */
function parseInline(
  buf: Buffer,
  pos: number,
  end: number,
  lim: Limits,
): Parsed | null {
  let nl = buf.indexOf(LF, pos);
  if (nl >= end) nl = -1;
  if (nl < 0) {
    if (end - pos > lim.maxInline) {
      throw new ProtocolError('too big inline request');
    }
    return null;
  }
  if (nl - pos > lim.maxInline) {
    throw new ProtocolError('too big inline request');
  }
  const args = buf
    .toString('latin1', pos, nl)
    .split(/[ \t\r\v\f]+/)
    .filter((f) => f.length > 0);
  if (args.length > lim.maxArgs) {
    throw new ProtocolError('too many inline arguments');
  }
  return { args, consumed: nl + 1 - pos };
}

/**
 * Returns the offset of the CR ending the line that starts at pos, or -1 if
 * the line hasn't fully arrived.
 */
function readLine(buf: Buffer, pos: number, end: number, lim: Limits): number {
  let cr = buf.indexOf(CR, pos);
  if (cr >= end) cr = -1;
  if (cr < 0 || cr + 1 >= end) {
    if (end - pos > lim.maxInline) {
      throw new ProtocolError('too big count string');
    }
    return -1;
  }
  if (cr - pos > lim.maxInline) {
    throw new ProtocolError('too big count string');
  }
  if (buf[cr + 1] !== LF) throw new ProtocolError('expected CRLF');
  return cr;
}

/**
 * Parses the decimal in buf[from, to). Stricter than Number(): no sign but a
 * leading minus, no spaces, no empty string, and at most 15 digits, so the
 * result is always an exact integer.
 */
function parseLength(buf: Buffer, from: number, to: number): number | null {
  let neg = false;
  if (from < to && buf[from] === 0x2d /* '-' */) {
    neg = true;
    from++;
  }
  if (from >= to || to - from > 15) return null;
  let v = 0;
  for (let i = from; i < to; i++) {
    const d = buf[i] - 0x30;
    if (d < 0 || d > 9) return null;
    v = v * 10 + d;
  }
  return neg ? -v : v;
}
