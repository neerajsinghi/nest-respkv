# ADR 0003: Group commit on the thread pool, with replies held by log position

**Status:** Accepted

## Context

Under `appendfsync always`, a write mustn't be acknowledged until it's on stable storage. fsync takes milliseconds (about 5 ms on the laptop used for testing). Node runs commands on one thread, so a synchronous `fsyncSync` per write would cap the whole server, reads included, at about 200 operations per second.

## Options

| | A. `fsyncSync` after every batch | B. Async `fs.fsync`, replies held until their log position is durable | C. Async fsync, but only the writer waits |
|---|---|---|---|
| Event loop blocked during fsync | Yes | No | No |
| Writes per fsync | One batch | Everything written meanwhile | Everything written meanwhile |
| A reader can see a write that isn't durable yet | No | No | Yes |
| Complexity | Low | Moderate: positions, waiters, ordering | Moderate |

## Decision

Option B.

- Records are written to the file with a synchronous `write(2)` at the end of each batch, before any reply leaves. That keeps every policy safe against a process crash.
- The log tracks two positions: bytes written and bytes known durable. Every outgoing byte, a reply or a pub/sub message, is tagged with the written position at the time and held until the durable position reaches it.
- At most one `fs.fsync` is in flight. When it finishes, held output is released, and if anything is still waiting another fsync starts, covering everything written meanwhile.
- A connection's output is never reordered: once something is held, everything after it queues behind.

Option C is cheaper for readers but lets a client read a value, act on it, and then have it vanish in a power cut. Redis avoids that too: it sends all replies of an event-loop iteration after that iteration's fsync.

## Consequences

- Measured with `redis-benchmark`: 180 writes per second with one client, about 4,200 with 50, so throughput grows with concurrency. Under `everysec` the same load runs at about 57k.
- Reads are delayed only while a write is waiting on fsync. When nothing is pending, their position is already durable and they go straight out.
- If fsync fails, everything waiting on it is closed without a reply, and the log refuses further writes.
- A client that pipelines many writes without reading could pile up held output, so a connection stops reading once 4 MiB is held.

## Revisit when

A disk with very fast fsync makes the holding machinery unnecessary, or replication arrives, where acknowledging after a replica has the write may replace waiting for local fsync.
