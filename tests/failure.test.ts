import { test } from "node:test";
import assert from "node:assert";
import { signDueEntries } from "../dispatcher.ts";
import redis from "../redis.ts";

test("transport failure requeues the delivery, then marks it dead, never loses it", async () => {
  const id = "transport-fail";

  await redis.del(`delivery:${id}`);
  await redis.del("retry:zset");
  await redis.hset(`delivery:${id}`, {
    eventId: "e1",
    subscriberId: id,
    url: "http://localhost:1", // dead port
    payload: "hi",
    attempts: 0,
    max_attempts: 3,
  });
  await redis.hset(`subscriber:${id}`, { secret: "shh" });

  await redis.zadd("retry:zset", Date.now(), id);

  await signDueEntries();

  assert.strictEqual(await redis.hget(`delivery:${id}`, "attempts"), "1");
  assert.strictEqual(await redis.hget(`delivery:${id}`, "status"), null);

  for (let i = 0; i < 5; i++) {
    if ((await redis.hget(`delivery:${id}`, "status")) === "dead") break;
    await redis.zadd("retry:zset", Date.now(), id);
    await signDueEntries();
  }
  assert.strictEqual(await redis.hget(`delivery:${id}`, "status"), "dead");
});

test("a delivery missing its url is marked dead, not retried", async () => {
  const id = "missing-url";
  await redis.del(`delivery:${id}`);
  await redis.del("retry:zset");
  await redis.hset(`delivery:${id}`, {
    eventId: "e1",
    subscriberId: id,
    payload: "hi",
    attempts: 0,
    max_attempts: 3,
  });
  await redis.hset(`subscriber:${id}`, { secret: "shh" });

  await redis.zadd("retry:zset", Date.now(), id);
  
  await signDueEntries();

  assert.strictEqual(await redis.hget(`delivery:${id}`, "status"), "dead");
});