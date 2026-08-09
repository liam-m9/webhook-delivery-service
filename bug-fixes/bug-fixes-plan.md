# Webhook Delivery Service — Bug Fixes Plan

This document outlines the bug fixes, concurrency improvements, and technical updates for the webhook delivery engine.

---

## Workflow & Documentation Model

- **`bug-fixes-plan.md`** (this file) is the reference plan: prioritized bugs, problem statements, fix approaches, and core concepts.
- **`bug-fixes-log.md`** contains the completed engineering decisions and defensible interview records per fix.

---

## Bug Fixes Backlog

Legend: **P0** correctness & data durability, **P1** security & idempotency, **P2** scale & telemetry, **P3** boundary typing & error handling.

### [P0] Data loss on non-HTTP failure
- **Where:** `dispatcher.ts`, `signDueEntries` / `getDueEntries`
- **Problem:** When `getDueEntries` claims an item, it removes it from `retry:zset`. If `fetch` throws a transport exception (connection refused, DNS failure, timeout), the catch block logged and skipped without writing a terminal or retry status, silently losing the delivery.
- **Fix approach:** Route transport errors through `handleFailure(id, attempts, max)` to reschedule retries with backoff. Mark jobs with missing URLs or secrets as `dead` immediately.
- **Concept:** At-least-once delivery semantics; why transport failures and 5xx errors share a failure class.
- **Branch:** `fix/transport-failure-terminal-state`
- **Status:** done

### [P0] Overlapping dispatcher ticks
- **Where:** `run-dispatcher.ts`
- **Problem:** `setInterval` fires callbacks on wall-clock time without awaiting async HTTP operations. Ticks taking longer than 1s overlap, inflating memory/sockets and breaking graceful shutdown on `SIGINT`.
- **Fix approach:** Replace `setInterval` with a self-scheduling loop (`setTimeout`) that awaits completion before scheduling the next tick.
- **Concept:** Event loop execution order; preventing single-process tick overlap by construction.
- **Branch:** `fix/dispatcher-no-overlap`
- **Status:** done

### [P0] Non-atomic claim
- **Where:** `dispatcher.ts`, `getDueEntries`
- **Problem:** `ZRANGEBYSCORE` and `ZREM` executed as two separate Redis commands. Multiple concurrent dispatcher workers could both read the same due delivery IDs before removal, dispatching duplicate webhooks.
- **Fix approach:** Execute range read and removal inside a single Redis Lua script (`EVAL`).
- **Concept:** Single-threaded Redis execution model; atomic Lua script evaluation (`EVALSHA`).
- **Branch:** `fix/atomic-claim-lua`
- **Status:** done

### [P1] No replay protection
- **Where:** `signer.ts`, `dispatcher.ts`, `receiver.ts`
- **Problem:** Signing only the payload allowed captured payload-signature pairs to be replayed indefinitely.
- **Fix approach:** Sign `${timestamp}.${nonce}.${payload}`. Receiver validates signatures, enforces a 5-minute timestamp window, and executes `SET nonce 1 EX 300 NX` in Redis to reject duplicate nonces.
- **Concept:** Webhook replay attack vectors; signed timestamps and atomic nonce caching.
- **Branch:** `fix/signed-timestamp-replay`
- **Status:** done

### [P1] No idempotency key exposed to consumers
- **Where:** `server.ts`, `dispatcher.ts`
- **Problem:** `deliveryId` was generated at ingestion but omitted from the POST body sent to receivers. Because `nonce` and `timestamp` change on every retry attempt for replay security, consumers could not distinguish retries from new delivery attempts.
- **Fix approach:** Pass `deliveryId: id` in the POST payload sent by `dispatcher.ts`. Receivers use `deliveryId` to deduplicate incoming webhooks and return 200 OK without re-executing business logic.
- **Concept:** At-least-once delivery vs effectively-once consumer processing; stable delivery identifiers.
- **Branch:** `fix/expose-delivery-id`
- **Status:** done

---

## Future Backlog Items

### [P2] N+1 fan-out in /events
- **Where:** `server.ts`, `/events`
- **Problem:** Per-subscriber Redis operations (`hget`, `hset`, `zadd`) are awaited sequentially in a loop. `SMEMBERS` pulls all subscriber IDs into memory at once.
- **Fix approach:** Pipeline Redis commands using `redis.pipeline()`. Transition from `SMEMBERS` to `SSCAN` for large subscriber fleets.
- **Concept:** Network round-trip latency minimization; Redis pipelining; set scanning.
- **Branch:** `perf/pipeline-fanout`
- **Status:** todo

### [P2] No delivery index, dead-letter, or TTL
- **Where:** Redis data model
- **Problem:** `delivery:{id}` hashes are orphaned once removed from `retry:zset`, preventing listing or inspecting terminal states. Terminal hashes persist indefinitely, increasing RAM usage.
- **Fix approach:** Maintain an `all_deliveries` index or status set; create a dead-letter set (`dlq:set`); attach TTLs to terminal delivery keys.
- **Concept:** Key-value secondary indexing; dead-letter queue patterns; key eviction strategies.
- **Branch:** `feat/delivery-index-dlq-ttl`
- **Status:** todo

### [P2] No metrics
- **Where:** `server.ts`, `dispatcher.ts`
- **Problem:** Telemetry (delivery success rate, retry distribution, dead rates) exists only as logs.
- **Fix approach:** Increment Redis counters (`stats:completed`, `stats:retried`, `stats:dead`) at terminal state transitions and expose via `GET /stats`.
- **Concept:** Webhook engine operational telemetry; counter aggregation.
- **Branch:** `feat/metrics-stats-endpoint`
- **Status:** todo

### [P3] Typed Redis boundary
- **Where:** `dispatcher.ts`, `redis.ts`
- **Problem:** `hmget` returns positional arrays without strong type enforcement or parsing for numerical fields like `attempts`.
- **Fix approach:** Define `Delivery` types and implement a `getDelivery(id)` wrapper with Zod schema validation.
- **Concept:** Compile-time TypeScript types vs runtime data validation; type boundaries.
- **Branch:** `refactor/typed-redis-boundary`
- **Status:** todo

### [P3] redis.ts has no error handler
- **Where:** `redis.ts`
- **Problem:** Redis client connection errors emit unhandled error events.
- **Fix approach:** Attach `redis.on("error", ...)` handler.
- **Concept:** `ioredis` error event loop handling.
- **Branch:** `fix/redis-error-handler`
- **Status:** todo