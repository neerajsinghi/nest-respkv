import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_LIMITS, parseCommand } from '../resp/parser.js';

export interface LoadResult {
  /** Commands applied. */
  commands: number;
  /** Bytes of incomplete tail removed from the file. */
  truncated: number;
}

const READ_CHUNK = 1024 * 1024;

/**
 * Replays the AOF at file through apply, which throws if a command fails. A
 * missing file is an empty log.
 *
 * An incomplete final command, or a final MULTI with no EXEC, is what a crash
 * mid-write leaves behind. Those commands were never acknowledged under any
 * policy that promised durability, so the tail is cut off and loading
 * succeeds. Malformed bytes that aren't simply a short tail mean real
 * corruption, and loading refuses to guess: starting anyway would silently
 * lose data.
 */
export function loadAof(
  file: string,
  apply: (args: string[]) => void,
): LoadResult {
  const res: LoadResult = { commands: 0, truncated: 0 };
  let fd: number;
  try {
    fd = fs.openSync(file, 'r+');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return res;
    throw err;
  }
  try {
    let buf = Buffer.allocUnsafe(READ_CHUNK);
    let len = 0; // bytes held in buf
    let offset = 0; // file offset of buf[0]
    let good = 0; // end of the last fully applied command or transaction
    let pending: string[][] = [];
    let inTx = false;
    let eof = false;
    for (;;) {
      let pos = 0;
      while (pos < len) {
        if (buf[pos] !== 0x2a /* '*' */) {
          throw new Error(
            `aof: corrupt at offset ${offset + pos}: expected a command`,
          );
        }
        let parsed;
        try {
          parsed = parseCommand(buf, pos, len, DEFAULT_LIMITS);
        } catch (err) {
          throw new Error(
            `aof: corrupt at offset ${offset + pos}: ${(err as Error).message}`,
          );
        }
        if (parsed === null) break;
        pos += parsed.consumed;
        const end = offset + pos;
        const args = parsed.args;
        if (args.length === 0) continue;
        const name = args[0].toUpperCase();
        if (name === 'MULTI') {
          inTx = true;
          pending = [];
        } else if (name === 'EXEC') {
          for (const cmd of pending) {
            applyAt(apply, cmd, end);
            res.commands++;
          }
          inTx = false;
          pending = [];
          good = end;
        } else if (inTx) {
          pending.push(args);
        } else {
          applyAt(apply, args, end);
          res.commands++;
          good = end;
        }
      }
      buf.copy(buf, 0, pos, len);
      len -= pos;
      offset += pos;
      if (eof) break;
      if (buf.length - len < READ_CHUNK / 4) {
        const grown = Buffer.allocUnsafe(buf.length * 2);
        buf.copy(grown, 0, 0, len);
        buf = grown;
      }
      const n = fs.readSync(fd, buf, len, buf.length - len, offset + len);
      if (n === 0) eof = true;
      len += n;
    }
    const size = offset + len;
    if (good < size) {
      res.truncated = size - good;
      fs.ftruncateSync(fd, good);
      fs.fsyncSync(fd);
    }
    return res;
  } finally {
    fs.closeSync(fd);
  }
}

function applyAt(
  apply: (args: string[]) => void,
  args: string[],
  end: number,
): void {
  try {
    apply(args);
  } catch (err) {
    throw new Error(
      `aof: replay before offset ${end}: ${(err as Error).message}`,
    );
  }
}

/** Writes all of buf, looping over short writes. */
export function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

/**
 * Fsyncs the directory holding file, which is what makes a file's creation or
 * rename durable.
 */
export function syncDir(file: string): void {
  const fd = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
