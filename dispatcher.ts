import "dotenv/config";
import { sign, buildSignedPayload } from "./signer.ts";
import redis from "./redis.ts";
import crypto from 'crypto'

const BASE_DELAY = 5000;

async function handleFailure(
  id: string,
  attempts: string | null,
  max: string | null,
) {
  const backOffDelay = BASE_DELAY * 2 ** Number(attempts);
  const cappedDelay = Math.min(backOffDelay, 300000);
  // if max attempts exeeds limit, status = dead
  if (Number(attempts) + 1 >= Number(max)) {
    await redis.hset(`delivery:${id}`, { status: "dead" });
    console.log("Job Dead");
  }
  // else increment attempts +1 and log new score w/ backoff delay
  else {
    await redis.hset(`delivery:${id}`, {
      attempts: Number(attempts) + 1,
    });
    await redis.zadd("retry:zset", Date.now() + cappedDelay, id);
    console.log(
      `Attempt failed. Retrying after ${cappedDelay}ms... (count: ${Number(attempts) + 1})`,
    );
  }
}

export async function getDueEntries(batchSize: number) {
  const limitArgs = ["LIMIT", "0", String(batchSize)];
  const atomicScript = `
    local items = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5]) 
    if #items > 0 then 
      redis.call('ZREM', KEYS[1], unpack(items))
    end 
    return items
   `;
  try {
    const dueDeliveryIds = (await redis.eval(
      atomicScript,
      1, // number of set
      "retry:zset",
      "-inf",
      Date.now().toString(),
      ...limitArgs,
    )) as string[];
    return dueDeliveryIds ?? [];
  } catch (e: unknown) {
    console.error(e);
    return [];
  }
}

export async function signDueEntries() {
  const ids = await getDueEntries(5);
  for (const id of ids) {
    const record = await redis.hmget(
      `delivery:${id}`,
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
    if (data.url == null || data.payload == null || secretLookup == null) {
      console.log(`Skipping ${id}: missing url or payload or secret`);
      await redis.hset(`delivery:${id}`, { status: "dead" }); // missing vital data = dead
      continue;
    }
    const timestamp = Date.now()
    const nonce = crypto.randomBytes(16).toString('base64')
    const builtPayload = buildSignedPayload(data.payload, timestamp, nonce)
    const hashedBuiltPayload = sign(builtPayload, secretLookup);
    // do we even get a response ?
    let response: Response;
    try {
      response = await fetch(data.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: data.eventId,
          subscriberId: data.subscriberId,
          payload: data.payload,
          timestamp: timestamp,
          nonce: nonce,
          signature: hashedBuiltPayload,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error: unknown) {
      // request/response timeout error
      if (error instanceof Error && error.name === "TimeoutError") {
        console.log(`Delivery ${id}: request timed out`);
      }
      // request never made it to/from server
      else {
        console.log(`Delivery ${id}: transport error`, error);
      }
      await handleFailure(id, data.attempts, data.max_attempts);
      continue;
    }
    // do we get an optimal response ?
    if (!response.ok) {
      await handleFailure(id, data.attempts, data.max_attempts);
    } else {
      await redis.hset(`delivery:${id}`, { status: "completed" });
      console.log("Job Completed");
    }
  }
}
