# Webhook Delivery (Redis)

HMAC-signed webhook delivery with Redis-sorted-set-based retry and backoff scheduling, no Bull/BullMQ, just `ioredis` and TypeScript on plain Node.

After building the Postgres-backed job queue and learning the core concepts, safe concurrent claiming, retries, backoff, from scratch with no framework, I wanted to see how the same ideas played out on a different datastore. Redis actually turned out to be the easier half of the two builds, not because the concepts were simpler, but because I'd already learned them the hard way with Postgres, so this project was mostly about learning new syntax rather than new ideas.

## Architecture

```mermaid
flowchart LR
    C["send-event.ts<br/>POST /events"] --> S["server.ts"]
    C2["POST /subscriptions"] --> S
    S -->|hset / sadd / zadd| R[("Redis")]
    D["dispatcher.ts<br/>via run-dispatcher.ts"] -->|atomic Lua claim| R
    D -->|sign, then POST| RV["receiver.ts<br/>subscriber"]
    RV -->|verify, respond| D
```

Three separate processes, on purpose, not one script doing everything:

- **`server.ts`** is the ingest API. `POST /subscriptions` registers a subscriber (generates an `id` and `secret`, stores their `url`). `POST /events` fans one event out to every subscriber, creating a `delivery` record for each and queuing it. It never talks to a subscriber directly, its job ends once the delivery is queued.
- **`dispatcher.ts`** (run on a loop by `run-dispatcher.ts`) is a background worker, not a server. Nothing calls it, it polls Redis on its own schedule, finds deliveries that are due, signs each payload, and POSTs it to the subscriber's registered URL.
- **`receiver.ts`** plays the role of a subscriber's own server. It verifies the signature on anything it receives and responds success or failure, which is what actually drives `dispatcher.ts`'s retry/backoff decisions.

## Redis key design

| Key | Type | Purpose |
|---|---|---|
| `subscriber:{id}` | hash | `url`, `secret` for one registered subscriber |
| `all_subscribers` | set | every subscriber id, so `/events` knows who to fan out to |
| `delivery:{id}` | hash | `eventId`, `subscriberId`, `url`, `payload`, `attempts`, `max_attempts`, `status` |
| `retry:zset` | sorted set | member = delivery id, score = timestamp (ms) it's next due to be attempted |

## Setup

```bash
docker compose up -d --wait
npm install
cp .env.example .env
```

Registering your first subscriber and finishing `.env` is covered in the Demo section below.

## Demo

Four terminals. `.env` changes only take effect on restart, so update `SUBSCRIBER_SECRET` *before* starting `receiver.ts`, not after.

```bash
# terminal 1
npx tsx server.ts

# register a subscriber (Postman/curl), url: http://localhost:3001/
# paste the returned secret into .env as SUBSCRIBER_SECRET
# set FAIL_COUNT=2 in .env for the interesting retry story

# terminal 2 (start after .env is updated)
npx tsx receiver.ts

# terminal 3
npx tsx run-dispatcher.ts

# terminal 4
npx tsx send-event.ts
```

Watch terminals 2 and 3: the delivery fails twice with a growing delay (backoff doubling each attempt), then succeeds on the third try. Set `DOWN=true` instead and it'll retry until `max_attempts` is hit and the delivery goes `dead`.

## Testing

```bash
npm test
```

The tests need a running Redis instance, `docker compose up -d --wait` provides it.

`tests/retry.test.ts` spins up a real throwaway HTTP server per test (no mocking) and proves, against the actual `dispatcher.ts` functions:

- a delivery that fails a couple of times eventually reaches `status: "completed"`
- a delivery that always fails eventually reaches `status: "dead"` once `max_attempts` is hit
- `verify()` correctly rejects a signature with the wrong payload, secret, or signature
- `verify()` correctly accepts a signature that genuinely matches

`tests/claim.test.ts` proves the claim step is actually atomic under concurrency: 15 callers claim batches from 100 due deliveries at the same time, and every delivery is claimed exactly once, no double-claims, nothing left behind.

`tests/failure.test.ts` proves failures can't strand a delivery: a transport-level failure (connection refused or timeout with no HTTP response) requeues the delivery with backoff and eventually marks it `dead` at `max_attempts`, and a malformed delivery record (missing url or secret) is marked `dead` immediately instead of being retried forever.

Tests in `tests/retry.test.ts` cover nonce-cache replay detection and signature rejection when the signed timestamp is altered. The receiver's five-minute stale-timestamp branch is implemented but not directly integration-tested.

## Design decisions

**Why a Redis sorted set (`retry:zset`) instead of `setTimeout` or a cron job for scheduling retries?** Durability is the main one: the schedule lives in Redis, not in process memory, so it survives a crash, a restart, or a redeploy in a way `setTimeout` timers never could. The score gives every delivery its own independent due-time, so exponential backoff per delivery falls out naturally, a single cron job checking on a fixed schedule can't do that as cleanly. It's also multi-worker safe: any number of `dispatcher.ts` processes can poll the same set, and an atomic Lua claim (read-and-remove in one script) is what hands a delivery to a worker, so two workers can't grab the same one the way two independent timers could never coordinate at all. `run-dispatcher.ts` still polls internally, but as a self-scheduling loop that only starts the next tick after the current one finishes, and only to ask "is anything due right now", the actual scheduling is durable, sitting in Redis.

**Why does `dispatcher.ts` look up a subscriber's secret fresh every time, instead of copying it onto the delivery record when it's created?** Drift. If the secret were copied at creation time and the original ever changed, the delivery record would keep the stale copy, and a retry later would sign with the wrong value. Referencing the original instead of copying it means there's only ever one place the secret lives, so it can't fall out of sync with itself.

**Why `crypto.timingSafeEqual` instead of `===` for comparing signatures?** `===` bails out at the first mismatched character, which leaks timing information, an attacker can brute-force one byte at a time by measuring which guess takes marginally longer to fail. `timingSafeEqual` gives no such signal, so the attacker is forced to guess the entire signature at once, which is practically impossible for signatures of real length.

**Why is the claim step a Lua script instead of `zrangebyscore` then `zrem`?** The first version was exactly those two separate commands, chosen while learning Redis because it's simple to read and correct for a single dispatcher. The tradeoff was a gap between the read and the remove: with multiple dispatchers running at once, two workers could claim the same delivery and send it twice. Once the basic commands were solid, the read-and-remove moved into a single Lua script, which Redis runs atomically, closing that gap, and `tests/claim.test.ts` proves it, with 15 concurrent claimers over 100 due deliveries and zero double-claims.

**How are replay attacks prevented?** Signing the payload alone doesn't stop an attacker from capturing a valid webhook and re-sending it. The receiver runs three checks: first it verifies a signature generated over `${timestamp}.${nonce}.${payload}`, proving the timestamp and nonce weren't tampered with. Next, it rejects any timestamp older than 5 minutes. Finally, it uses a Redis `SET key 1 EX 300 NX` on the nonce; if Redis returns null, the nonce was already used within the 5-minute window and the request is rejected.

**Why is `deliveryId` exposed in the POST payload sent to subscribers?** At-least-once delivery over networks means retries can happen after the receiver has already processed a webhook. Consumers need a stable idempotency key to deduplicate retries. Because `nonce` and `timestamp` change on every attempt for replay protection, a retry carries a fresh nonce and looks brand new to the receiver. Exposing `deliveryId` (which is generated at ingest and stays constant across all retries) gives the consumer a stable key to skip duplicate work and return 200 OK so the dispatcher stops retrying.

**Why split `dispatcher.ts` and `run-dispatcher.ts` into two files, mirroring the `worker.ts`/`run-worker.ts` pattern from the sibling job-queue-service project?** Mainly to avoid side effects on import. If `signDueEntries` and the polling loop lived in the same file, importing it anywhere (like in `retry.test.ts`) would start the polling loop automatically, whether you wanted it running or not. Keeping them separate means `dispatcher.ts` can be imported and called as many times as needed with nothing running in the background, which makes it actually testable, and it means the runner is swappable, the same `signDueEntries` function could be driven by a scheduled AWS Lambda instead of the local polling loop without touching the core logic at all.

## Known limitations

- **No authentication on the ingest API.** Anyone who can reach `server.ts` can register a subscriber or POST an event, no API key, no auth of any kind. Fine for a local demo, not something you'd ship.
- **Dead deliveries are silently terminal.** Once `status` flips to `dead`, there's no dead-letter queue, no alerting, and no endpoint to inspect how many deliveries have died or why.
- **Delivery records never expire.** `delivery:{id}` hashes accumulate in Redis forever, since Redis is RAM-backed, this would eventually become a real memory problem at scale.
- **`receiver.ts` only simulates one subscriber at a time.** It verifies against a single `SUBSCRIBER_SECRET` read from its own `.env`, while `server.ts` correctly generates a unique secret per subscriber and `dispatcher.ts` correctly looks each one up individually. The demo receiver's single hardcoded secret is a shortcut for local testing, not a reflection of how the actual signing/verification logic works, that part is genuinely per-subscriber.
