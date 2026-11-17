import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { encodeCommand } from '../resp/reply-writer.js';
import { loadAof } from './aof-file.js';

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'respkv-aof-'));
  return path.join(dir, 'test.aof');
}

function write(file: string, ...parts: (string[] | Buffer)[]): number {
  const buf = Buffer.concat(
    parts.map((p) => (Buffer.isBuffer(p) ? p : encodeCommand(p))),
  );
  fs.writeFileSync(file, buf);
  return buf.length;
}

function load(file: string): {
  applied: string[][];
  truncated: number;
  commands: number;
} {
  const applied: string[][] = [];
  const res = loadAof(file, (args) => applied.push(args));
  return { applied, ...res };
}

describe('loadAof', () => {
  it('treats a missing file as an empty log', () => {
    expect(load(tempFile())).toEqual({
      applied: [],
      truncated: 0,
      commands: 0,
    });
  });

  it('replays commands and unwraps transactions', () => {
    const file = tempFile();
    write(
      file,
      ['SET', 'a', '1'],
      ['MULTI'],
      ['INCR', 'a'],
      ['DEL', 'b'],
      ['EXEC'],
    );
    expect(load(file).applied).toEqual([
      ['SET', 'a', '1'],
      ['INCR', 'a'],
      ['DEL', 'b'],
    ]);
  });

  it('cuts off a command torn by a crash', () => {
    const file = tempFile();
    const good = write(file, ['SET', 'a', '1']);
    fs.appendFileSync(file, encodeCommand(['SET', 'b', '2']).subarray(0, 10));
    const res = load(file);
    expect(res.applied).toEqual([['SET', 'a', '1']]);
    expect(res.truncated).toBe(10);
    expect(fs.statSync(file).size).toBe(good);
    expect(load(file).truncated).toBe(0);
  });

  it('drops a transaction that never reached EXEC', () => {
    const file = tempFile();
    const good = write(file, ['SET', 'a', '1']);
    fs.appendFileSync(
      file,
      Buffer.concat([encodeCommand(['MULTI']), encodeCommand(['INCR', 'a'])]),
    );
    const res = load(file);
    expect(res.applied).toEqual([['SET', 'a', '1']]);
    expect(fs.statSync(file).size).toBe(good);
  });

  it('refuses corruption that is not just a short tail', () => {
    const file = tempFile();
    write(file, ['SET', 'a', '1'], Buffer.from('garbage\r\n'), [
      'SET',
      'b',
      '2',
    ]);
    expect(() => load(file)).toThrow('aof: corrupt at offset 27');
    write(file, Buffer.from('*1\r\n$x\r\n'));
    expect(() => load(file)).toThrow('invalid bulk length');
  });

  it('reports which command failed to apply', () => {
    const file = tempFile();
    write(file, ['SET', 'a', '1'], ['BAD']);
    expect(() =>
      loadAof(file, (args) => {
        if (args[0] === 'BAD') throw new Error('nope');
      }),
    ).toThrow('aof: replay before offset 40: nope');
  });

  it('reads files larger than its buffer, including one large value', () => {
    const file = tempFile();
    const big = 'x'.repeat(3 * 1024 * 1024);
    const cmds: string[][] = [['SET', 'big', big]];
    for (let i = 0; i < 50_000; i++) cmds.push(['RPUSH', 'l', String(i)]);
    write(file, ...cmds);
    const res = load(file);
    expect(res.commands).toBe(cmds.length);
    expect(res.applied[0][2]).toHaveLength(big.length);
    expect(res.applied.at(-1)).toEqual(['RPUSH', 'l', '49999']);
  });
});
