# Commands

Everything here speaks RESP2 and follows Redis semantics, except as listed under [differences](#differences-from-redis). Command names aren't case-sensitive.

## Keys

| Command | Notes |
|---|---|
| `DEL key [key ...]`, `UNLINK key [key ...]` | `UNLINK` is an alias: there's no background freeing |
| `EXISTS key [key ...]` | |
| `TYPE key` | |
| `KEYS pattern` | Scans every key while every other client waits. Avoid on large datasets |
| `RENAME key newkey` | Keeps the TTL |
| `EXPIRE key seconds`, `PEXPIRE key ms` | No `NX`/`XX`/`GT`/`LT` options. Expiry times beyond 2^53 ms are rejected |
| `EXPIREAT key unix-s`, `PEXPIREAT key unix-ms` | |
| `TTL key`, `PTTL key` | -2 if missing, -1 if no TTL |
| `PERSIST key` | |
| `DBSIZE` | Includes expired keys not yet collected, as Redis does |
| `FLUSHALL`, `FLUSHDB` | Same thing: there's one database. `ASYNC` is ignored |

## Strings

| Command | Notes |
|---|---|
| `GET key` | |
| `SET key value [NX\|XX] [GET] [EX s\|PX ms\|EXAT s\|PXAT ms\|KEEPTTL]` | |
| `SETNX key value` | |
| `SETEX key seconds value`, `PSETEX key ms value` | |
| `GETDEL key` | |
| `MGET key [key ...]`, `MSET key value [key value ...]` | |
| `APPEND key value`, `STRLEN key` | |
| `INCR key`, `DECR key`, `INCRBY key n`, `DECRBY key n` | Keep the TTL. Exact over all of int64; overflow is an error |

## Lists

| Command | Notes |
|---|---|
| `LPUSH key value [value ...]`, `RPUSH key value [value ...]` | |
| `LPOP key [count]`, `RPOP key [count]` | |
| `LLEN key`, `LINDEX key index` | `LINDEX` is O(1), on a ring buffer |
| `LRANGE key start stop` | |
| `LSET key index value` | |
| `LTRIM key start stop` | |

## Hashes

`HSET key field value [field value ...]`, `HGET key field`, `HMGET key field [field ...]`, `HDEL key field [field ...]`, `HEXISTS key field`, `HLEN key`, `HGETALL key`, `HKEYS key`, `HVALS key`, `HINCRBY key field n`

## Sets

`SADD key member [member ...]`, `SREM key member [member ...]`, `SISMEMBER key member`, `SCARD key`, `SMEMBERS key`, `SPOP key [count]`, `SINTER key [key ...]`, `SUNION key [key ...]`, `SDIFF key [key ...]`

## Sorted sets

| Command | Notes |
|---|---|
| `ZADD key [NX\|XX] [CH] score member [score member ...]` | No `GT`, `LT` or `INCR` |
| `ZREM key member [member ...]` | |
| `ZSCORE key member`, `ZCARD key`, `ZRANK key member` | |
| `ZINCRBY key increment member` | |
| `ZRANGE key start stop [WITHSCORES]` | By rank only: no `BYSCORE`, `BYLEX` or `REV` |
| `ZREVRANGE key start stop [WITHSCORES]` | |
| `ZRANGEBYSCORE key min max [WITHSCORES] [LIMIT offset count]` | Supports `(` for exclusive bounds, and `-inf`/`+inf` |

## Transactions

`MULTI`, `EXEC`, `DISCARD`. There is no `WATCH`.

## Pub/sub

`SUBSCRIBE channel [channel ...]`, `UNSUBSCRIBE [channel ...]`, `PUBLISH channel message`. There are no pattern subscriptions. While subscribed, only `SUBSCRIBE`, `UNSUBSCRIBE`, `PING` and `QUIT` are allowed.

## Connection and server

| Command | Notes |
|---|---|
| `PING [message]`, `ECHO message`, `QUIT` | |
| `AUTH [default] password` | Only the `default` user exists |
| `HELLO [2 [AUTH default password]]` | Asking for protocol 3 returns `NOPROTO`, which clients treat as "fall back to RESP2" |
| `SELECT 0` | Any other database is an error |
| `INFO` | Sections are ignored: everything is always returned |
| `REWRITEAOF` | Compacts the log. **Blocks every client while it runs.** Not part of Redis |
| `COMMAND`, `CONFIG GET`, `CLIENT SETNAME`/`SETINFO`/`GETNAME`/`ID` | Minimal stubs, because clients send these on connect. `COMMAND` returns an empty list, `CONFIG GET` finds nothing |

## Differences from Redis

The differential test compares equivalent replies and deliberately ignores the first three of these.

- **Error messages.** The class (`ERR`, `WRONGTYPE`, ...) matches, but the wording after it may not.
- **Float formatting.** Scores use the shortest text that parses back to the same number, laid out exactly as go-respkv does. Where this server returns `0.1`, Redis 7.0 returned `0.10000000000000001`.
- **Exact TTL values.** The test compares only whether a TTL exists, since the two servers' clocks differ.
- **Unordered replies.** `KEYS`, `SMEMBERS`, `HGETALL` and similar have no defined order in either server, and the orders differ.
- **Inline commands** split on whitespace only, and don't interpret quotes. Real clients don't use this form, but typing into `telnet` does.
- **Value size.** One argument can be at most 536,870,888 bytes, V8's longest string, which is 24 bytes short of Redis's 512 MiB.
- **One database.** `SELECT` accepts only 0, and there's no `MOVE` or `SWAPDB`.
- **`REWRITEAOF` instead of `BGREWRITEAOF`**, because it isn't in the background.
- **Default port 6380**, not 6379.
- **`MISCONF`** appears when the log has failed, with its own wording.

Tested with `redis-cli` 7.0.5, `redis-benchmark` 7.0.5 and `ioredis` 6.0.0, covering commands, binary values, pipelines, `MULTI`, password authentication and pub/sub. Other clients should work, but haven't been tried.
