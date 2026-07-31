import { test } from "node:test";
import assert from "node:assert";
import { getDueEntries } from "../dispatcher.ts";
import redis from "../redis.ts";

test("concurrent callers never double-claim the same due delivery", async () => {
  const TOTAL = 100, WORKERS = 15, BATCH = 10;

  await redis.del("retry:zset");

  const pastScore = Date.now() - 1000; // score in the past = due now
  const pipeline = redis.pipeline();
  for (let i = 0; i < TOTAL; i++) pipeline.zadd("retry:zset", pastScore, `claim-${i}`);
  await pipeline.exec();

  const results = await Promise.all(
    Array.from({ length: WORKERS }, () => getDueEntries(BATCH)),
  );
  const claimed = results.flat();

  assert.strictEqual(new Set(claimed).size, claimed.length, "an id was claimed more than once");
  assert.strictEqual(claimed.length, TOTAL, "not every delivery was claimed exactly once");
  assert.strictEqual(await redis.zcard("retry:zset"), 0, "retry set not empty after claim");
});