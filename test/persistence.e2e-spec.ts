import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { AofService } from '../src/persistence/aof.service.js';
import {
  RespClient,
  RespError,
  sleep,
  startServer,
  tempDir,
  TestServer,
} from './helpers.js';
import type { RespkvConfig } from '../src/config/config.js';

const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString(
  'latin1',
);

/** Everything a client can observe about the dataset, for comparing restarts. */
async function dump(c: RespClient): Promise<Record<string, unknown>> {
  const keys = ((await c.call('KEYS', '*')) as string[]).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const type = await c.call('TYPE', k);
    let value: unknown;
    if (type === 'string') value = await c.call('GET', k);
    else if (type === 'list') value = await c.call('LRANGE', k, 0, -1);
    else if (type === 'hash')
      value = ((await c.call('HGETALL', k)) as string[]).join(',');
    else if (type === 'set')
      value = ((await c.call('SMEMBERS', k)) as string[]).sort();
    else value = await c.call('ZRANGE', k, 0, -1, 'WITHSCORES');
    out[k] = { type, value, ttl: ((await c.call('TTL', k)) as number) > 0 };
  }
  return out;
}

describe('persistence', () => {
  let dir: string;
  let aofPath: string;
  const servers: TestServer[] = [];
  const clients: RespClient[] = [];

  async function start(
    overrides: Partial<RespkvConfig> = {},
  ): Promise<[TestServer, RespClient]> {
    const s = await startServer({ aofPath, ...overrides });
    const c = await RespClient.connect(s.port);
    servers.push(s);
    clients.push(c);
    return [s, c];
  }

  beforeEach(() => {
    dir = tempDir();
    aofPath = path.join(dir, 'data.aof');
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    for (const s of servers.splice(0)) await s.close();
  });

  async function populate(c: RespClient): Promise<void> {
    await c.call('SET', 'str', 'hello');
    await c.call('SET', 'bin', binary);
    await c.call('SET', 'ttl', 'v', 'EX', '1000');
    await c.call('INCRBY', 'n', '41');
    await c.call('INCR', 'n');
    await c.call('RPUSH', 'list', 'a', 'b', 'c', 'd');
    await c.call('LPOP', 'list');
    await c.call('HSET', 'hash', 'f1', 'v1', 'f2', 'v2');
    await c.call('HDEL', 'hash', 'f2');
    await c.call('SADD', 'set', 'x', 'y', 'z');
    await c.call('SPOP', 'set');
    await c.call('ZADD', 'zset', '0.1', 'a', '-inf', 'b', '2', 'c');
    await c.call('ZINCRBY', 'zset', '0.2', 'a');
    await c.call('MULTI');
    await c.call('SET', 'tx1', '1');
    await c.call('RPUSH', 'tx2', 'x');
    await c.call('EXEC');
    await c.call('SET', 'gone', 'v');
    await c.call('DEL', 'gone');
    await c.call('SET', 'short', 'v', 'PX', '20');
  }

  it('rebuilds the same dataset on restart', async () => {
    const [s1, c1] = await start();
    await populate(c1);
    await sleep(40);
    expect(await c1.call('GET', 'short')).toBe(null);
    const before = await dump(c1);
    await s1.close();

    const [, c2] = await start();
    expect(await dump(c2)).toEqual(before);
    // The key that expired was logged as a DEL, so replay agrees about it.
    expect(fs.readFileSync(aofPath, 'latin1')).toContain(
      '$3\r\nDEL\r\n$5\r\nshort',
    );
  });

  it('logs relative expiry as an absolute time', async () => {
    const [s1, c1] = await start();
    await c1.call('SET', 'k', 'v', 'EX', '100');
    await c1.call('EXPIRE', 'other', '5');
    await c1.call('SET', 'other', 'v');
    await c1.call('EXPIRE', 'other', '100');
    await s1.close();
    const log = fs.readFileSync(aofPath, 'latin1');
    expect(log).toMatch(/PXAT\r\n\$13\r\n\d{13}\r\n/);
    expect(log).toMatch(/PEXPIREAT\r\n\$5\r\nother\r\n\$13\r\n\d{13}\r\n/);
    expect(log).not.toContain('EXPIRE\r\n');
  });

  it('starts after a crash tore the last write, and refuses real corruption', async () => {
    const [s1, c1] = await start();
    await c1.call('SET', 'kept', 'v');
    await s1.close();
    fs.appendFileSync(aofPath, '*3\r\n$3\r\nSET\r\n$4\r\nlost');
    const [s2, c2] = await start();
    expect(await c2.call('GET', 'kept')).toBe('v');
    expect(await c2.call('EXISTS', 'lost')).toBe(0);
    await s2.close();

    fs.appendFileSync(aofPath, 'not resp at all\r\n');
    await expect(startServer({ aofPath })).rejects.toThrow(
      'aof: corrupt at offset',
    );
  });

  it('acknowledges no write under always before it is on disk', async () => {
    const [s1] = await start({ appendfsync: 'always' });
    const writers = await Promise.all(
      Array.from({ length: 20 }, () => RespClient.connect(s1.port)),
    );
    clients.push(...writers);
    let missing = 0;
    await Promise.all(
      writers.map(async (w, i) => {
        for (let j = 0; j < 50; j++) {
          const item = `<${i}:${j}>`;
          expect(await w.call('RPUSH', 'l', item)).toEqual(expect.any(Number));
          // By the time the reply arrives, the record has to be in the file.
          if (!fs.readFileSync(aofPath, 'latin1').includes(item)) missing++;
        }
      }),
    );
    expect(missing).toBe(0);
    await s1.close();
    const [, c2] = await start();
    expect(await c2.call('LLEN', 'l')).toBe(1000);
  });

  it('compacts the log with REWRITEAOF and keeps the data', async () => {
    const [s1, c1] = await start();
    await populate(c1);
    for (let i = 0; i < 2000; i++) c1.write('SET', 'churn', i);
    for (let i = 0; i < 2000; i++) await c1.read();
    for (let i = 0; i < 2500; i++) c1.write('RPUSH', 'biglist', i);
    for (let i = 0; i < 2500; i++) await c1.read();
    await sleep(40);
    const before = await dump(c1);
    const sizeBefore = fs.statSync(aofPath).size;
    expect(await c1.call('REWRITEAOF')).toBe('OK');
    expect(fs.statSync(aofPath).size).toBeLessThan(sizeBefore);
    // Writes after the rewrite land in the new file.
    await c1.call('SET', 'after', 'rewrite');
    before.after = { type: 'string', value: 'rewrite', ttl: false };
    await s1.close();

    const [, c2] = await start();
    expect(await dump(c2)).toEqual(before);
  });

  it('refuses writes but keeps serving reads after the log fails', async () => {
    const [s1, c1] = await start({ admin: { host: '127.0.0.1', port: 0 } });
    await s1.app.listen(0, '127.0.0.1');
    const http = (s1.app.getHttpServer().address() as AddressInfo).port;
    const health = async () =>
      (await fetch(`http://127.0.0.1:${http}/health`)).status;
    await c1.call('SET', 'k', 'v');
    expect(await health()).toBe(200);

    // Swap the log's descriptor for a read-only one, so the next write fails.
    const aof = s1.app.get(AofService) as unknown as { fd: number };
    const realFd = aof.fd;
    aof.fd = fs.openSync('/dev/null', 'r');
    fs.closeSync(realFd);

    await expect(c1.call('SET', 'k', 'lost')).rejects.toThrow(
      'connection closed',
    );
    const c2 = await RespClient.connect(s1.port);
    clients.push(c2);
    expect(await c2.call('GET', 'k')).toBe('lost'); // applied in memory, never acknowledged
    expect(await c2.call('SET', 'k', 'x')).toEqual(
      expect.objectContaining({ kind: 'MISCONF' }),
    );
    expect(await c2.call('MULTI')).toBe('OK');
    expect(await c2.call('SET', 'k', 'x')).toBeInstanceOf(RespError);
    expect(await c2.call('EXEC')).toEqual(
      expect.objectContaining({ kind: 'EXECABORT' }),
    );
    expect(await c2.call('INFO')).toContain('aof_last_write_status:err');
    expect(await health()).toBe(503);
  });
});
