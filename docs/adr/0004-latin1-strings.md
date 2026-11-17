# ADR 0004: Hold keys and values as latin1 strings

**Status:** Accepted

## Context

Redis keys and values are arbitrary bytes. In Node the natural type for bytes is `Buffer`, but keys, hash fields, set members and sorted set members also have to be `Map` keys, and `Map` compares Buffers by identity, not content.

## Options

| | A. Buffers for values, strings for keys | B. Latin1 strings everywhere | C. UTF-8 strings |
|---|---|---|---|
| Binary-safe | Yes | Yes: one character per byte | No: invalid UTF-8 is replaced |
| Memory per small value | Small Buffers are slices of shared 8 KiB slabs, so one live value keeps its whole slab alive | One byte per character in V8, no sharing | One byte per ASCII character |
| `APPEND` | Copies the whole value | A rope, flattened on next read | A rope |
| Copies | Parse: one per value. Reply: none | Parse: one. Reply: one | Same as B, but lossy |
| Largest value | 512 MiB | 536,870,888 bytes, V8's limit | Same as B |

## Decision

Option B. The parser decodes every argument with `toString('latin1')`, and the reply writer encodes with `write(s, 'latin1')`. Bytes round-trip exactly, a test checks all 256 byte values, and lists, hashes, sets and sorted sets all hold plain strings. Comparing latin1 strings with `<` compares bytes, which gives sorted sets Redis's member ordering for free.

Option A's slab retention was the deciding problem: allocating each value with `Buffer.allocUnsafeSlow` avoids it, but costs a separate backing store per value, which is worse than a string.

## Consequences

- One extra copy per reply, which the benchmarks don't show as a bottleneck.
- The largest value is 24 bytes smaller than Redis's. The parser enforces this limit, so an oversized value is a clean protocol error instead of a crash.
- Passwords from the environment are UTF-8 while `AUTH` arguments are latin1, so `AUTH` re-encodes its argument to bytes before hashing. A test covers a non-ASCII password.

## Revisit when

Large values dominate the workload, where Buffers avoid the copy on reply, or Node adds a way to share a backing store without slab retention.
