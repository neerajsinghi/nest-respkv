import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  Reply,
  RespClient,
  RespError,
  sleep,
  startServer,
  tempDir,
  TestServer,
} from './helpers.js';

const redisServer = spawnSync('which', ['redis-server'])
  .stdout?.toString()
  .trim();
const describeIfRedis = redisServer ? describe : describe.skip;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Commands whose reply order neither server defines. */
const UNORDERED = new Set([
  'KEYS',
  'SMEMBERS',
  'SINTER',
  'SUNION',
  'SDIFF',
  'HKEYS',
  'HVALS',
]);

/** A float's text, canonicalised: Redis 7.0 prints 0.1 as 0.10000000000000001. */
function canonicalFloats(v: Reply): Reply {
  if (
    typeof v === 'string' &&
    /^-?(\d|inf)/.test(v) &&
    !Number.isNaN(Number(v.replace('inf', 'Infinity')))
  ) {
    return String(Number(v.replace('inf', 'Infinity')));
  }
  return Array.isArray(v) ? v.map(canonicalFloats) : v;
}

/**
 * Makes replies comparable. Errors compare by class, since wording varies
 * across Redis versions; TTLs by sign, since the clocks differ; and order is
 * ignored where it's undefined.
 */
function normalize(cmd: string[], v: Reply): string {
  const name = cmd[0].toUpperCase();
  if (v instanceof RespError) return `error:${v.kind}`;
  if (name === 'HGETALL') {
    const items = v as string[];
    const pairs: string[] = [];
    for (let i = 0; i + 1 < items.length; i += 2)
      pairs.push(`${items[i]}=${items[i + 1]}`);
    return JSON.stringify(pairs.sort());
  }
  if (name === 'TTL' || name === 'PTTL')
    return (v as number) >= 0 ? 'positive' : String(v as number);
  if (UNORDERED.has(name)) return JSON.stringify([...(v as string[])].sort());
  return JSON.stringify(canonicalFloats(v), (_, x) =>
    typeof x === 'bigint' ? `${x}n` : x,
  );
}

/** A seeded generator, so a failing sequence can be replayed. */
function rng(seed: number): (n: number) => number {
  let x = (seed * 2654435761) >>> 0 || 1;
  return (n) => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) % n;
  };
}

/**
 * Draws from a small keyspace, so commands constantly collide on the same keys
 * and hit the wrong-type, missing-key and empty-collection paths.
 */
function genCommand(r: (n: number) => number): string[] {
  const pick = (xs: string[]) => xs[r(xs.length)];
  const key = () => pick(['a', 'b', 'c', 'd', 'e']);
  const member = () => pick(['x', 'y', 'z', 'w', 'v']);
  const val = () =>
    pick(['1', '2', '-7', 'abc', '', '3.5', '9223372036854775807', '007']);
  const idx = () => String(r(12) - 6);
  const score = () =>
    pick(['0', '1', '2.5', '-1', '1e3', 'inf', '-inf', 'bad', '0.1']);
  const bound = () => pick(['-inf', '+inf', '0', '(1', '2.5', '(2.5', 'bad']);
  switch (r(62)) {
    case 0:
    case 1:
    case 2:
      return ['SET', key(), val()];
    case 3:
      return ['SET', key(), val(), pick(['NX', 'XX', 'GET'])];
    case 4:
      return ['SET', key(), val(), 'EX', '100'];
    case 5:
      return ['SET', key(), val(), 'KEEPTTL'];
    case 6:
      return [
        'SET',
        key(),
        val(),
        pick(['NX', 'EX']),
        pick(['XX', '0', '-1', 'x']),
      ];
    case 7:
    case 8:
      return ['GET', key()];
    case 9:
      return ['GETDEL', key()];
    case 10:
      return ['SETNX', key(), val()];
    case 11:
      return ['SETEX', key(), pick(['100', '0', '-1', 'x']), val()];
    case 12:
      return ['MSET', key(), val(), key(), val()];
    case 13:
      return ['MGET', key(), key(), key()];
    case 14:
      return ['APPEND', key(), val()];
    case 15:
      return ['STRLEN', key()];
    case 16:
      return ['INCR', key()];
    case 17:
      return ['DECR', key()];
    case 18:
      return ['INCRBY', key(), val()];
    case 19:
      return ['DECRBY', key(), val()];
    case 20:
      return ['DEL', key(), key()];
    case 21:
      return ['EXISTS', key(), key()];
    case 22:
      return ['TYPE', key()];
    case 23:
      return ['KEYS', pick(['*', 'a*', '[a-c]', '?', '[^a]', 'z*'])];
    case 24:
      return ['RENAME', key(), key()];
    case 25:
      return ['EXPIRE', key(), pick(['100', '0', '-1', 'x'])];
    case 26:
      return ['TTL', key()];
    case 27:
      return ['PTTL', key()];
    case 28:
      return ['PERSIST', key()];
    case 29:
      return ['DBSIZE'];
    case 30:
    case 31:
      return ['LPUSH', key(), member(), member()];
    case 32:
      return ['RPUSH', key(), member()];
    case 33:
      return ['LPOP', key()];
    case 34:
      return ['RPOP', key(), pick(['0', '1', '2', '9', '-1', 'x'])];
    case 35:
      return ['LLEN', key()];
    case 36:
      return ['LINDEX', key(), idx()];
    case 37:
      return ['LRANGE', key(), idx(), idx()];
    case 38:
      return ['LSET', key(), idx(), member()];
    case 39:
      return ['LTRIM', key(), idx(), idx()];
    case 40:
    case 41:
      return ['HSET', key(), member(), val()];
    case 42:
      return ['HGET', key(), member()];
    case 43:
      return ['HMGET', key(), member(), member()];
    case 44:
      return ['HDEL', key(), member(), member()];
    case 45:
      return ['HEXISTS', key(), member()];
    case 46:
      return ['HLEN', key()];
    case 47:
      return ['HGETALL', key()];
    case 48:
      return ['HINCRBY', key(), member(), val()];
    case 49:
    case 50:
      return ['SADD', key(), member(), member()];
    case 51:
      return ['SREM', key(), member()];
    case 52:
      return ['SISMEMBER', key(), member()];
    case 53:
      return ['SCARD', key()];
    case 54:
      return [pick(['SMEMBERS', 'SINTER', 'SUNION', 'SDIFF']), key()];
    case 55:
      return [pick(['SINTER', 'SUNION', 'SDIFF']), key(), key()];
    case 56:
    case 57: {
      const cmd = ['ZADD', key()];
      if (r(3) === 0) cmd.push(pick(['NX', 'XX', 'CH']));
      return [...cmd, score(), member()];
    }
    case 58:
      return ['ZREM', key(), member()];
    case 59:
      return [pick(['ZSCORE', 'ZRANK']), key(), member()];
    case 60:
      switch (r(4)) {
        case 0:
          return ['ZRANGE', key(), idx(), idx()];
        case 1:
          return ['ZREVRANGE', key(), idx(), idx(), 'WITHSCORES'];
        case 2:
          return ['ZCARD', key()];
      }
      return ['ZINCRBY', key(), score(), member()];
  }
  return ['ZRANGEBYSCORE', key(), bound(), bound(), 'WITHSCORES'];
}

describeIfRedis('differential test against redis-server', () => {
  let redis: ChildProcess;
  let ours: TestServer;
  let theirs: RespClient;
  let mine: RespClient;

  beforeAll(async () => {
    const port = await freePort();
    redis = spawn(redisServer as string, [
      '--port',
      String(port),
      '--save',
      '',
      '--appendonly',
      'no',
      '--dir',
      tempDir(),
    ]);
    for (let i = 0; ; i++) {
      try {
        theirs = await RespClient.connect(port);
        break;
      } catch (e) {
        if (i === 100) throw e;
        await sleep(50);
      }
    }
    ours = await startServer();
    mine = await RespClient.connect(ours.port);
  });

  afterAll(async () => {
    theirs?.close();
    mine?.close();
    await ours?.close();
    redis?.kill();
  });

  it('gives equivalent replies to 40,000 random commands', async () => {
    for (let seed = 0; seed < 8; seed++) {
      const r = rng(seed + 1);
      await theirs.call('FLUSHALL');
      await mine.call('FLUSHALL');
      const history: string[][] = [];
      for (let i = 0; i < 5000; i++) {
        const cmd = genCommand(r);
        history.push(cmd);
        const want = normalize(cmd, await theirs.call(...cmd));
        const got = normalize(cmd, await mine.call(...cmd));
        if (got !== want) {
          throw new Error(
            `seed ${seed}: ${JSON.stringify(cmd)}\n ours  ${got}\n redis ${want}\n` +
              `recent: ${JSON.stringify(history.slice(-8))}`,
          );
        }
      }
    }
  });
});
