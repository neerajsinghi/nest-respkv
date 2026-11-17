# ADR 0001: Let the event loop serialise commands

**Status:** Accepted

## Context

Every command must be atomic, `MULTI`/`EXEC` must look atomic to other clients, and multi-key commands such as `MSET`, `RENAME` and `SINTER` must see a consistent view. go-respkv gets this from one global mutex. Node runs JavaScript on a single thread, so the question is different: what would let two commands interleave, and how to make sure nothing does.

Two commands can only interleave if one of them gives control back to the event loop part way through: an `await`, a callback, a promise. Nest's own request handling is built on exactly that: guards, interceptors, pipes and microservice handlers are all asynchronous.

## Options

| | A. Synchronous handlers on the event loop | B. Async handlers with a per-key or global async lock | C. Worker threads, sharded by key |
|---|---|---|---|
| Command and `EXEC` atomicity | Automatic | Only as good as the locking | Per shard; cross-shard `EXEC` needs coordination |
| Cost per command | A function call | A promise and lock bookkeeping | A message between threads |
| Uses more than one core | No | No | Yes |
| Risk of subtle bugs | Low, if handlers stay synchronous | High: every forgotten lock is a race | High |
| Fits Nest's async pipeline | No, it bypasses it | Yes | No |

## Decision

Option A. Handlers are plain synchronous methods, `Engine.dispatch` calls them directly, and the only asynchronous work, fsync and socket writes, happens after a batch of commands finishes.

Because the guarantee depends on every handler staying synchronous, it's enforced rather than left to convention: `CommandRegistry` refuses to start if any `@Command` method is an `async` function, and an end-to-end test checks that it does.

## Consequences

- Atomicity is free, the store has no locks, and the code is the same shape as go-respkv's minus the mutex.
- One core runs all commands. Pipelined, that's about 0.93–1.0M requests per second here against go-respkv's 1.28M, both on one core.
- Anything slow in a handler stalls everyone, so connections yield after 1024 commands or 256 KiB of replies, and fsync runs on the thread pool ([ADR 0003](0003-group-commit.md)). `KEYS` and `REWRITEAOF` still block everyone, as in Redis, and are documented.
- Nest's request pipeline isn't used for commands ([ADR 0002](0002-commands-as-providers.md)).

## Revisit when

One core is the proven bottleneck. Then prefer several independent processes with client-side sharding over worker threads inside one process: it keeps this model, and it also scales past one machine.
