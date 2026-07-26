import "dotenv/config";
import { sign } from "./signer.js";
import redis from "./redis.js";

const BASE_DELAY = 5000; // 5000ms = 5s

export async function getDueEntries(batchSize) {
  const dueDeliveryIds = await redis.zrangebyscore(
    "retry:zset",
    "-inf",
    Date.now(),
    "LIMIT",
    0,
    batchSize,
  );
  if (dueDeliveryIds.length > 0) {
    await redis.zrem("retry:zset", dueDeliveryIds);
    return dueDeliveryIds;
  } else return [];
}

export async function signDueEntries() {
  const entries = await getDueEntries(5);
  for (const entry of entries) {
    const record = await redis.hmget(
      `delivery:${entry}`,
      "eventId",
      "subscriberId",
      "url",
      "payload",
      "attempts",
      "max_attempts",
    );
    const data = {
      eventId: record[0],
      subscriberId: record[1],
      url: record[2],
      payload: record[3],
      attempts: record[4],
      max_attempts: record[5],
    };
    const secretLookup = await redis.hget(
      `subscriber:${data.subscriberId}`,
      "secret",
    );
    const hashedPayload = sign(data.payload, secretLookup);
    try {
      const response = await fetch(data.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: data.eventId,
          subscriberId: data.subscriberId,
          hashedPayload: hashedPayload,
          payload: data.payload,
        }),
        // abort signal in case the req hangs for too long
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        const backOffDelay = BASE_DELAY * 2 ** Number(data.attempts);
        const cappedDelay = Math.min(backOffDelay, 300000);
        // hmget/hget always returns strings
        if (Number(data.attempts) + 1 >= Number(data.max_attempts)) {
          await redis.hset(`delivery:${entry}`, { status: "dead" });
          console.log("job dead");
        } else {
          await redis.hset(`delivery:${entry}`, {
            attempts: Number(data.attempts) + 1,
          });
          await redis.zadd("retry:zset", Date.now() + cappedDelay, entry);
          console.log(
            `attempt failed, retrying... (new delay: ${cappedDelay}ms) (attempt count: ${Number(data.attempts)})`,
          );
        }
      } else {
        await redis.hset(`delivery:${entry}`, { status: "completed" });
        console.log("job completed");
      }
    } catch (error) {
      if (error.name == "TimeoutError") {
        console.log("request timed out");
      }
      console.log(error);
    }
  }
}
