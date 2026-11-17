import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { Command } from '../src/engine/command.decorator.js';
import { ServerStats } from '../src/engine/server-stats.js';
import {
  RespClient,
  RespError,
  sleep,
  startServer,
  TestServer,
  waitFor,
} from './helpers.js';

const err = (kind: string) => expect.objectContaining({ kind });

describe('server', () => {
  let server: TestServer;
  let c: RespClient;

  beforeEach(async () => {
    server = await startServer();
    c = await RespClient.connect(server.port);
  });

  afterEach(async () => {
    c.close();
    await server.close();
  });

  describe('protocol', () => {
    it('answers pipelined commands in order, however the bytes are split', async () => {
      const raw = Buffer.from(
        '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$5\r\nhello\r\n' +
          '*2\r\n$3\r\nGET\r\n$1\r\nk\r\n' +
          'PING\r\n' +
          '*2\r\n$4\r\nECHO\r\n$0\r\n\r\n',
      );
      for (let i = 0; i < raw.length; i++) {
        c.send(raw.subarray(i, i + 1));
        if (i % 7 === 0) await sleep(1);
      }
      expect(await c.read()).toBe('OK');
      expect(await c.read()).toBe('hello');
      expect(await c.read()).toBe('PONG');
      expect(await c.read()).toBe('');
    });

    it('keeps every byte of a binary value', async () => {
      const value = Buffer.from(
        Array.from({ length: 256 }, (_, i) => i),
      ).toString('latin1');
      expect(await c.call('SET', 'bin', value)).toBe('OK');
      expect(await c.call('GET', 'bin')).toBe(value);
      expect(await c.call('STRLEN', 'bin')).toBe(256);
    });

    it('runs a long pipeline across several batches', async () => {
      const n = 5000;
      for (let i = 0; i < n; i++) c.write('INCR', 'counter');
      let last: unknown;
      for (let i = 0; i < n; i++) last = await c.read();
      expect(last).toBe(n);
    });

    it('reports errors and keeps the connection', async () => {
      expect(await c.call('NOSUCH', 'x')).toEqual(err('ERR'));
      expect(await c.call('GET')).toEqual(
        new RespError("ERR wrong number of arguments for 'get' command"),
      );
      expect(await c.call('SET', 'k', 'v', 'EX', '0')).toEqual(err('ERR'));
      await c.call('SET', 'k', 'v');
      expect(await c.call('LPUSH', 'k', 'x')).toEqual(err('WRONGTYPE'));
      expect(await c.call('PING')).toBe('PONG');
    });

    it('closes the connection after a protocol error', async () => {
      c.send('*1\r\n$x\r\n');
      expect(await c.read()).toEqual(err('ERR'));
      await c.closed;
    });

    it('never lets an echoed name break the reply framing', async () => {
      expect(await c.call('BAD\r\n+OK')).toEqual(
        new RespError("ERR unknown command 'BAD  +OK'"),
      );
      expect(await c.call('PING')).toBe('PONG');
    });

    it('closes after QUIT, ignoring commands pipelined behind it', async () => {
      c.write('QUIT');
      c.write('SET', 'after', 'quit');
      expect(await c.read()).toBe('OK');
      await c.closed;
      const d = await RespClient.connect(server.port);
      expect(await d.call('EXISTS', 'after')).toBe(0);
      d.close();
    });
  });

  describe('commands', () => {
    it('keeps int64 arithmetic exact', async () => {
      await c.call('SET', 'n', '9223372036854775806');
      expect(await c.call('INCR', 'n')).toBe(9223372036854775807n);
      expect(await c.call('INCR', 'n')).toEqual(err('ERR'));
      expect(await c.call('DECRBY', 'n', '-9223372036854775808')).toEqual(
        err('ERR'),
      );
      expect(await c.call('SET', 'z', '007')).toBe('OK');
      expect(await c.call('INCR', 'z')).toEqual(err('ERR'));
    });

    it('handles each collection type', async () => {
      expect(await c.call('RPUSH', 'l', 'a', 'b', 'c')).toBe(3);
      expect(await c.call('LPOP', 'l', '2')).toEqual(['a', 'b']);
      expect(await c.call('HSET', 'h', 'f1', 'v1', 'f2', 'v2')).toBe(2);
      expect(await c.call('HINCRBY', 'h', 'n', '5')).toBe(5);
      expect(await c.call('SADD', 's', 'x', 'y', 'z')).toBe(3);
      const popped = (await c.call('SPOP', 's', '2')) as string[];
      expect(popped).toHaveLength(2);
      expect(await c.call('SCARD', 's')).toBe(1);
      expect(await c.call('ZADD', 'z', '1', 'a', '0.1', 'b', 'inf', 'c')).toBe(
        3,
      );
      expect(await c.call('ZRANGE', 'z', '0', '-1', 'WITHSCORES')).toEqual([
        'b',
        '0.1',
        'a',
        '1',
        'c',
        'inf',
      ]);
      expect(
        await c.call('ZRANGEBYSCORE', 'z', '(0.1', '+inf', 'LIMIT', '0', '1'),
      ).toEqual(['a']);
      expect(await c.call('TYPE', 'z')).toBe('zset');
    });
  });

  describe('auth', () => {
    let auth: TestServer;
    let a: RespClient;

    beforeEach(async () => {
      auth = await startServer({ password: 'sésame' });
      a = await RespClient.connect(auth.port);
    });

    afterEach(async () => {
      a.close();
      await auth.close();
    });

    it('requires AUTH, then allows everything', async () => {
      expect(await a.call('GET', 'k')).toEqual(err('NOAUTH'));
      expect(await a.call('AUTH', 'wrong')).toEqual(err('WRONGPASS'));
      expect(await a.call('AUTH', 'other', 'sésame')).toEqual(err('WRONGPASS'));
      // The client sends UTF-8 bytes, which arrive here as latin1 characters.
      expect(
        await a.call('AUTH', Buffer.from('sésame').toString('latin1')),
      ).toBe('OK');
      expect(await a.call('GET', 'k')).toBe(null);
    });

    it('authenticates through HELLO and refuses RESP3', async () => {
      const pw = Buffer.from('sésame').toString('latin1');
      expect(await a.call('HELLO', '3', 'AUTH', 'default', pw)).toEqual(
        err('NOPROTO'),
      );
      const hello = (await a.call(
        'HELLO',
        '2',
        'AUTH',
        'default',
        pw,
      )) as unknown[];
      expect(hello.slice(0, 2)).toEqual(['server', 'respkv']);
      expect(await a.call('PING')).toBe('PONG');
    });

    it('limits what an unauthenticated client can send', async () => {
      a.write('SET', 'k', 'x'.repeat(20_000));
      expect(await a.read()).toEqual(err('ERR'));
      await a.closed;
    });

    it('lifts the limits for commands pipelined right after AUTH', async () => {
      const pw = Buffer.from('sésame').toString('latin1');
      a.write('AUTH', pw);
      a.write('SET', 'big', 'x'.repeat(100_000));
      expect(await a.read()).toBe('OK');
      expect(await a.read()).toBe('OK');
    });
  });

  describe('transactions', () => {
    it('runs queued commands together', async () => {
      expect(await c.call('MULTI')).toBe('OK');
      expect(await c.call('SET', 'a', '1')).toBe('QUEUED');
      expect(await c.call('INCR', 'a')).toBe('QUEUED');
      expect(await c.call('LPUSH', 'a', 'x')).toBe('QUEUED');
      expect(await c.call('EXEC')).toEqual(['OK', 2, err('WRONGTYPE')]);
      expect(await c.call('GET', 'a')).toBe('2');
    });

    it('aborts when a command was rejected while queueing', async () => {
      await c.call('MULTI');
      expect(await c.call('SET', 'a')).toEqual(err('ERR'));
      await c.call('SET', 'b', '1');
      expect(await c.call('EXEC')).toEqual(err('EXECABORT'));
      expect(await c.call('EXISTS', 'b')).toBe(0);
    });

    it('rejects misplaced MULTI, EXEC and DISCARD', async () => {
      expect(await c.call('EXEC')).toEqual(err('ERR'));
      expect(await c.call('DISCARD')).toEqual(err('ERR'));
      await c.call('MULTI');
      expect(await c.call('MULTI')).toEqual(err('ERR'));
      expect(await c.call('DISCARD')).toBe('OK');
    });

    it('lets no other client run in the middle of EXEC', async () => {
      const d = await RespClient.connect(server.port);
      c.write('MULTI');
      for (let i = 0; i < 2000; i++) c.write('RPUSH', 'l', 'c');
      c.write('EXEC');
      const readers = Array.from({ length: 50 }, () => d.call('LLEN', 'l'));
      const lens = (await Promise.all(readers)) as number[];
      expect(lens.every((n) => n === 0 || n === 2000)).toBe(true);
      d.close();
    });
  });

  describe('expiry', () => {
    it('removes keys lazily and actively', async () => {
      await c.call('SET', 'lazy', 'v', 'PX', '30');
      for (let i = 0; i < 100; i++)
        await c.call('SET', `k${i}`, 'v', 'PX', '30');
      expect(await c.call('DBSIZE')).toBe(101);
      await sleep(60);
      expect(await c.call('GET', 'lazy')).toBe(null);
      // Nothing reads the others; the active cycle has to find them.
      const deadline = Date.now() + 3000;
      while ((await c.call('DBSIZE')) !== 0 && Date.now() < deadline)
        await sleep(50);
      expect(await c.call('DBSIZE')).toBe(0);
      expect(server.app.get(ServerStats).expiredKeys).toBe(101);
    });

    it('reports TTLs and clears them', async () => {
      await c.call('SET', 'k', 'v', 'EX', '100');
      expect(await c.call('TTL', 'k')).toBe(100);
      expect(await c.call('PERSIST', 'k')).toBe(1);
      expect(await c.call('TTL', 'k')).toBe(-1);
      expect(await c.call('TTL', 'missing')).toBe(-2);
      expect(await c.call('EXPIRE', 'k', '-1')).toBe(1);
      expect(await c.call('EXISTS', 'k')).toBe(0);
    });
  });

  describe('pub/sub', () => {
    it('delivers messages after the SUBSCRIBE reply, in order', async () => {
      const sub = await RespClient.connect(server.port);
      expect(await sub.call('SUBSCRIBE', 'news', 'other')).toEqual([
        'subscribe',
        'news',
        1,
      ]);
      expect(await sub.read()).toEqual(['subscribe', 'other', 2]);
      expect(await c.call('PUBLISH', 'news', 'one')).toBe(1);
      expect(await c.call('PUBLISH', 'news', 'two')).toBe(1);
      expect(await c.call('PUBLISH', 'nobody', 'x')).toBe(0);
      expect(await sub.read()).toEqual(['message', 'news', 'one']);
      expect(await sub.read()).toEqual(['message', 'news', 'two']);
      expect(await sub.call('GET', 'k')).toEqual(err('ERR'));
      expect(await sub.call('PING')).toEqual(['pong', '']);
      expect(await sub.call('UNSUBSCRIBE')).toEqual(
        expect.arrayContaining(['unsubscribe']),
      );
      await sub.read();
      expect(await sub.call('GET', 'k')).toBe(null);
      sub.close();
    });

    it('disconnects a subscriber that stops reading, without slowing publishers', async () => {
      const slow = await startServer({ maxOutboxBytes: 256 * 1024 });
      const pub = await RespClient.connect(slow.port);
      const sub = await RespClient.connect(slow.port);
      await sub.call('SUBSCRIBE', 'firehose');
      sub.socket.pause();
      const msg = 'x'.repeat(16 * 1024);
      for (let i = 0; i < 2000; i++) pub.write('PUBLISH', 'firehose', msg);
      let last: unknown;
      for (let i = 0; i < 2000; i++) last = await pub.read();
      expect(last).toBe(0);
      expect(slow.app.get(ServerStats).rejectedClients).toBe(1);
      pub.close();
      sub.close();
      await slow.close();
    });
  });

  describe('backpressure', () => {
    it('serves others while one client floods without reading, then drops it', async () => {
      const slow = await startServer({ writeTimeoutMs: 300 });
      const hog = await RespClient.connect(slow.port);
      const other = await RespClient.connect(slow.port);
      await other.call('SET', 'big', 'x'.repeat(1024 * 1024));
      hog.socket.pause();
      for (let i = 0; i < 500; i++) hog.write('GET', 'big');
      await sleep(50);
      const started = Date.now();
      expect(await other.call('PING')).toBe('PONG');
      expect(Date.now() - started).toBeLessThan(200);
      // A paused socket never reports the close, so watch the server's side.
      await waitFor(() => slow.app.get(ServerStats).connectedClients === 1);
      hog.close();
      other.close();
      await slow.close();
    });
  });

  describe('limits', () => {
    it('refuses clients beyond maxClients', async () => {
      const small = await startServer({ maxClients: 1 });
      const first = await RespClient.connect(small.port);
      expect(await first.call('PING')).toBe('PONG');
      const second = await RespClient.connect(small.port);
      expect(await second.read()).toEqual(err('ERR'));
      await second.closed;
      first.close();
      await small.close();
    });
  });
});

describe('command registry', () => {
  it('refuses an async command handler at startup', async () => {
    @Injectable()
    class AsyncCommands {
      @Command('SLOW', { arity: 1 })
      async slow(): Promise<void> {}
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register({ ...DEFAULT_CONFIG, admin: null })],
      providers: [AsyncCommands],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await expect(app.init()).rejects.toThrow('must be synchronous');
    await app.close();
  });
});
