# Webhook Delivery Service — Engineering & Hardening Log

This document records the architectural decisions, bug fixes, and concurrency hardening implemented for the webhook delivery engine. Each section details the technical root cause, the chosen implementation, trade-offs, and verification.

---

## [P0] Data Loss on Non-HTTP Failure (branch: `fix/transport-failure-terminal-state`)

### Problem
`getDueEntries` claims a delivery by removing it from the Redis sorted set (`retry:zset`). In earlier iterations, if the HTTP request failed before a response object was returned (e.g. connection refused, DNS error, or timeout), control landed in a catch block that logged the error and continued. Because the entry was already removed from `retry:zset` and never written to a terminal state (`completed` or `dead`), the delivery was silently stranded and lost. A similar issue existed when target URLs or secrets were missing.

### Solution & Design
- Consolidated failure processing into `handleFailure(id, attempts, max)` called from both non-200 HTTP responses and network exception handlers.
- If a delivery fails due to transport errors or 5xx status codes, `handleFailure` increments `attempts` and reschedules the job in `retry:zset` with exponential backoff.
- Missing configuration fields (URL or subscriber secret) transition immediately to `dead` rather than consuming retries, as missing data cannot be resolved by retrying.
- Narrowed the `try` block scope strictly to the `fetch` execution so Redis write failures during handling do not trigger secondary error loops.

### Trade-offs & Alternatives
- **Routing missing fields through retries:** Rejected. Retrying invalid configuration wastes Redis operations and delay windows on jobs that are unrecoverable.
- **Defensible position:** Transport errors and timeouts do not prove delivery failure (the receiver may have processed the payload before dropping the ACK). Retrying is the required behavior for at-least-once durability. Missing structural fields, however, indicate unrecoverable data corruption and are terminated immediately.

---

## [P0] Overlapping Dispatcher Ticks (branch: `fix/dispatcher-no-overlap`)

### Problem
Executing `signDueEntries` inside a fixed `setInterval` (e.g. every 1000ms) causes tick overlapping. If network calls or timeouts take longer than the interval duration, multiple worker ticks run concurrently within the same process. This leads to unbounded socket consumption and prevents graceful shutdown, as process termination signals (`SIGINT`) only awaited the handle of the latest tick while earlier ticks were still executing.

### Solution & Design
- Replaced `setInterval` with a self-scheduling loop using an awaited delay.
- The next tick is only scheduled after the active tick completes execution (`signDueEntries`), structurally preventing tick overlap.
- Process signal handlers update a `stopped` flag and await the single in-flight promise before process termination.

### Trade-offs & Alternatives
- **`isTicking` flag inside `setInterval`:** Rejected. Bailing early still incurs timer overhead every second and requires manual promise tracking to ensure clean shutdown.
- **Defensible position:** A self-scheduling loop guarantees single-process concurrency by construction. It ensures that in-flight network requests finish cleanly before the process exits.

---

## [P0] Non-Atomic Claim (branch: `fix/atomic-claim-lua`)

### Problem
Executing `ZRANGEBYSCORE` followed by `ZREM` as separate Redis commands creates a race condition across concurrent dispatcher processes. If Worker A and Worker B execute `ZRANGEBYSCORE` before either issues `ZREM`, both read the same due delivery IDs and dispatch duplicate webhooks.

### Solution & Design
- Enclosed the range read and removal inside a single Redis Lua script executed via `EVAL`.
- Because Redis is single-threaded, the Lua script executes atomically to completion before any other command is processed.
- Parameterized dynamic values (`ARGV`, timestamps, batch limits) via `ARGV` to keep the script string constant, enabling Redis script caching via `EVALSHA`.

### Trade-offs & Alternatives
- **String interpolation inside Lua:** Rejected. Dynamically generating Lua script strings changes the script hash, bypassing Redis script caching and inflating memory usage.
- **Defensible position:** Redis single-threaded execution guarantees that Lua scripts run atomically. Static script parameterization ensures low-overhead execution via `EVALSHA` while eliminating multi-worker claim races.

---

## [P1] Replay Protection (branch: `fix/signed-timestamp-replay`)

### Problem
Signing only the payload allowed captured payload-signature pairs to be retransmitted indefinitely by malicious actors.

### Solution & Design
- Expanded the signed string format to `${timestamp}.${nonce}.${payload}` using HMAC-SHA256.
- The receiver validates signature authenticity, rejects timestamps outside a 5-minute tolerance window, and executes `SET nonce 1 EX 300 NX` in Redis.
- If Redis returns `null`, the nonce was previously registered within the active window, and the request is rejected as a replay attack.

### Trade-offs & Alternatives
- **Timestamp verification without nonces:** Rejected. Timestamp tolerance limits the attack surface to 5 minutes but still leaves a window for rapid payload retransmission.
- **Defensible position:** Combining HMAC signatures with timestamp tolerance bounds storage overhead, while atomic Redis `SET NX` locks close replay vulnerabilities within that window.

---

## [P1] Idempotency Key Exposure (branch: `fix/expose-delivery-id`)

### Problem
`server.ts` generates a unique `deliveryId` at ingestion and stores it in `delivery:${deliveryId}`, but `dispatcher.ts` omitted it from the POST payload sent to subscribers. Because `nonce` and `timestamp` change on every retry attempt to maintain replay security, consumers could not distinguish retries from new delivery attempts.

### Solution & Design
- Added `deliveryId: id` to the JSON payload sent by `dispatcher.ts`.
- `deliveryId` remains constant across all retry attempts for a given delivery job.
- Receivers use `deliveryId` as a stable key to deduplicate incoming webhooks. On duplicate receipt, the consumer skips business logic and returns HTTP `200 OK`, allowing the dispatcher to mark the job `completed` and cease retries.

### Trade-offs & Alternatives
- **Deduplicating on `nonce` or `signature`:** Rejected. `nonce` is regenerated per attempt for anti-replay security, causing retries to appear as new requests.
- **Deduplicating on `eventId`:** Rejected. One event fans out to multiple subscribers and does not identify a specific delivery process stream.
- **Defensible position:** Webhook engines operating over unreliable networks guarantee at-least-once delivery. Exposing a stable `deliveryId` allows consumers to implement idempotency checks, turning at-least-once delivery into effectively-once execution.

---

## Future Hardening Backlog (P2 & P3)

### [P2] N+1 fan-out in /events (branch: `perf/pipeline-fanout`)
- **Concept:** Network round-trips as the primary cost model; Redis pipelining (`pipeline()`); moving from `SMEMBERS` to `SSCAN` at scale.
- **Status:** todo

### [P2] No delivery index, dead-letter, or TTL (branch: `feat/delivery-index-dlq-ttl`)
- **Concept:** Secondary indexes in key-value stores; dead-letter sets; hash TTLs and eviction strategies.
- **Status:** todo

### [P2] No metrics (branch: `feat/metrics-stats-endpoint`)
- **Concept:** Webhook platform telemetry (delivery success rate, retry distribution, dead rates); counters vs logs; `GET /stats`.
- **Status:** todo

### [P3] Typed Redis boundary (branch: `refactor/typed-redis-boundary`)
- **Concept:** Compile-time TS types vs runtime boundary parsing; Zod schema validation; `getDelivery(id)` wrapper.
- **Status:** todo

### [P3] redis.ts has no error handler (branch: `fix/redis-error-handler`)
- **Concept:** `ioredis` connection lifecycle and unhandled error event dispatching.
- **Status:** todo
