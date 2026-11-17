# nest-respkv

[![CI](https://github.com/neerajsinghi/nest-respkv/actions/workflows/ci.yml/badge.svg)](https://github.com/neerajsinghi/nest-respkv/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A Redis-compatible in-memory key-value server built with NestJS.**

It speaks RESP2, so `redis-cli`, `redis-benchmark` and client libraries such as `ioredis` work unchanged. It has strings, lists, hashes, sets and sorted sets, plus TTLs, an append-only file, transactions and pub/sub, and HTTP health and stats endpoints.

It's a port of [go-respkv](https://github.com/neerajsinghi/go-respkv) with the same 84 commands, the same AOF format (either server can load the other's file), and the same durability promises.

## Why it exists

To see how far NestJS's structure can go in a server where every microsecond counts, and where it has to stop. Nest provides the modules, dependency injection, lifecycle and command discovery: a command is a method marked `@Command('SET', { arity: -3, write: true })` on any provider. The per-command path skips Nest's async request pipeline, because an `await` in the middle of a command would let another client's command run inside it. The [design doc](docs/DESIGN.md) explains the split.

As with the Go version, compatibility is tested, not assumed: a test sends the same 40,000 random commands to this server and to a real `redis-server` and requires equivalent replies.

**It isn't a production replacement for Redis.** It has no replication, eviction or `SCAN` yet. See [what's missing](#whats-missing).

## Quickstart

Needs Node.js 22.12 or later.

```bash
npm install
```

```bash
npm run build
```

```bash
RESPKV_AOF=data.aof npm start
```

Then, in another terminal (the default port is 6380, so it won't collide with a local Redis):

```bash
redis-cli -p 6380 SET greeting hello EX 60
```

```bash
redis-cli -p 6380 GET greeting
```

```bash
curl -s localhost:6381/health
```

## Configuration

All settings are environment variables, and a malformed value stops startup rather than silently falling back to a default.

| Variable | Default | Meaning |
|---|---|---|
| `RESPKV_ADDR` | `127.0.0.1:6380` | Address for RESP clients |
| `RESPKV_AOF` | off | Append-only file path. Without it, data lives only in memory |
| `RESPKV_APPENDFSYNC` | `everysec` | `always`, `everysec` or `no` |
| `RESPKV_PASSWORD` | none | Require `AUTH` with this password |
| `RESPKV_MAXCLIENTS` | `10000` | Connection limit |
| `RESPKV_ADMIN_ADDR` | `127.0.0.1:6381` | Address for `GET /health` and `GET /stats`, or `off` |

`/health` returns 200, or 503 once the AOF has failed and writes are being refused, so an orchestrator can take the instance out of service.

## Documentation

- [Design](docs/DESIGN.md): what Nest does and doesn't do here, request lifecycle, execution model, data structures, persistence, flow control, failure modes, capacity and roadmap, with diagrams
- [Commands](docs/COMMANDS.md): every supported command, and the known differences from Redis
- Decision records: [event-loop execution](docs/adr/0001-event-loop-execution.md), [commands as providers](docs/adr/0002-commands-as-providers.md), [group commit](docs/adr/0003-group-commit.md), [latin1 strings](docs/adr/0004-latin1-strings.md)

## Performance

`redis-benchmark` with 50 clients and a pipeline of 16, on one M1 Max laptop with Node 23.4, with client and servers on the same machine and persistence off. Requests per second, all three measured in the same session:

| | SET | GET |
|---|---|---|
| nest-respkv | 0.93M | 1.01M |
| go-respkv | 1.28M | 1.28M |
| Redis 7.0.5 | 1.08M | 1.27M |

Without pipelining, all three reach about 100k per second, which is the limit of the benchmark client rather than the servers. Memory is about 145 bytes per small key, against 153 for go-respkv and 104 for Redis. This is one laptop run, not a capacity promise. [Capacity](docs/DESIGN.md#11-capacity) has more, including the cost of `always`.

## What's missing

Replication and failover, memory limits with eviction, `SCAN`, `WATCH`, blocking commands such as `BLPOP`, pattern subscriptions, Lua, RESP3, TLS and a background AOF rewrite. The [roadmap](docs/DESIGN.md#13-roadmap) explains how each would fit.

## Development

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run lint
```

Unit tests live next to the code in `src/`. End-to-end tests in `test/` start the whole Nest application and talk to it over TCP, including the differential test, which runs when `redis-server` is on your `PATH` and is skipped otherwise. The project is native ESM, as Nest 12 is, and Jest runs it with `--experimental-vm-modules`.

## License

[MIT](LICENSE)
