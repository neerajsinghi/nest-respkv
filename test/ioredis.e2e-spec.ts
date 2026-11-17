import { Redis } from 'ioredis';
import { startServer, TestServer, waitFor } from './helpers.js';

/** A real client library, used the way an application would. */
describe('ioredis', () => {
  let server: TestServer;
  let redis: Redis;

  beforeAll(async () => {
    server = await startServer({ password: 'secret' });
    redis = new Redis({
      port: server.port,
      host: '127.0.0.1',
      password: 'secret',
      lazyConnect: true,
    });
    await redis.connect();
  });

  afterAll(async () => {
    redis.disconnect();
    await server.close();
  });

  it('runs commands with password auth', async () => {
    expect(await redis.set('greeting', 'hello', 'EX', 60)).toBe('OK');
    expect(await redis.get('greeting')).toBe('hello');
    expect(await redis.ttl('greeting')).toBeGreaterThan(0);
    expect(await redis.incrby('counter', 5)).toBe(5);
    expect(await redis.hset('user:1', { name: 'Ada', role: 'admin' })).toBe(2);
    expect(await redis.hgetall('user:1')).toEqual({
      name: 'Ada',
      role: 'admin',
    });
    expect(await redis.zadd('board', 10, 'ada', 20, 'bob')).toBe(2);
    expect(await redis.zrevrange('board', 0, -1, 'WITHSCORES')).toEqual([
      'bob',
      '20',
      'ada',
      '10',
    ]);
    await expect(redis.lpush('greeting', 'x')).rejects.toThrow('WRONGTYPE');
  });

  it('keeps binary values intact through Buffers', async () => {
    const value = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await redis.set('bin', value);
    expect(await redis.getBuffer('bin')).toEqual(value);
  });

  it('runs pipelines and transactions', async () => {
    const piped = await redis
      .pipeline()
      .set('p', '1')
      .incr('p')
      .get('p')
      .exec();
    expect(piped).toEqual([
      [null, 'OK'],
      [null, 2],
      [null, '2'],
    ]);
    const tx = await redis.multi().rpush('q', 'a', 'b').lpop('q').exec();
    expect(tx).toEqual([
      [null, 2],
      [null, 'a'],
    ]);
  });

  it('subscribes and receives messages', async () => {
    const sub = redis.duplicate();
    const got: string[] = [];
    sub.on('message', (channel: string, message: string) =>
      got.push(`${channel}:${message}`),
    );
    await sub.subscribe('events');
    expect(await redis.publish('events', 'one')).toBe(1);
    expect(await redis.publish('events', 'two')).toBe(1);
    await waitFor(() => got.length === 2);
    expect(got).toEqual(['events:one', 'events:two']);
    sub.disconnect();
  });
});
