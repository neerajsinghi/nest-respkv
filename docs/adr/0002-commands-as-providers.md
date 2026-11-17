# ADR 0002: Commands are discovered providers, dispatched outside Nest's request pipeline

**Status:** Accepted

## Context

There are 84 commands. Each needs some shared services (the keyspace, the AOF propagator, pub/sub), metadata (arity, whether it writes, whether it's allowed before `AUTH`, inside `MULTI` or while subscribed), and a way to be found by name. The point of using NestJS is to get structure from it, so the question is how much of Nest each command goes through.

## Options

| | A. Nest microservice with a custom transport | B. `@Command` methods found by discovery, called directly | C. A hand-written command table, Nest only at the edges |
|---|---|---|---|
| Adding a command | `@MessagePattern` on a method | `@Command` on a method | Write the function, add a table entry |
| Shared services | Injected | Injected | Passed by hand |
| Per-command overhead | Observable/promise per message, interceptors, serialisation | A map lookup and a function call | A map lookup and a function call |
| Atomicity | Lost: handlers are async, so commands interleave ([ADR 0001](0001-event-loop-execution.md)) | Kept | Kept |
| Testable with `Test.createTestingModule` | Yes | Yes | Partly |

## Decision

Option B. A command is a method on an ordinary injectable provider:

```ts
@Command('INCRBY', { arity: 3, write: true })
incrby(s: Session, args: string[]): void { ... }
```

At startup, `CommandRegistry` uses Nest's `DiscoveryService` and `MetadataScanner` to find every such method, binds it to its instance, and indexes it by name in both upper and lower case so lookups don't allocate. A method may carry several decorators, as `DEL` and `UNLINK` share one. Duplicate names and async handlers fail startup.

Per-client state is a plain `Session` object, not a request-scoped provider. A connection lives for many commands, and resolving providers per command would cost more than the commands do.

The TCP listener, `RespServer`, is a provider that owns a `net.Server`, started explicitly after `app.init()` so that AOF replay finishes before anything listens.

## Consequences

- Commands get Nest's DI and module structure, and adding one touches one file.
- Guards, interceptors and pipes don't apply to commands. Cross-cutting checks (auth, arity, pub/sub mode, `MISCONF`, `MULTI` queueing) are explicit code in `Engine.dispatch`, in the same order as Redis.
- The HTTP admin endpoints are a normal Nest controller, so they do get the full HTTP pipeline, where its cost doesn't matter.

## Revisit when

Nest gains a synchronous, allocation-free dispatch path for non-HTTP transports, or commands need cross-cutting behaviour (per-command metrics or ACLs, say) that would be clearer as interceptors. Even then, it should be added in `dispatch` without making handlers async.
