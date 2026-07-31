import { test } from "node:test";
import assert from "node:assert";
import type { AddressInfo } from "node:net";
import { createServer } from "http";
import crypto from "crypto";
import { sign, verify } from "./signer.js";
import { signDueEntries } from "./dispatcher.js";
import redis from "./redis.js";

test("retrying until success", async () => {
  let callCount = 0;
  const server = createServer((req, res) => {
    callCount += 1;
    if (callCount <= 2) {
      res.writeHead(500);
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    }
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://localhost:${port}`;

  const id = "retry-success";
  await redis.del(`delivery:${id}`);
  await redis.hset(`delivery:${id}`, {
    eventId: "e1",
    subscriberId: id,
    url: baseUrl,
    payload: "hello",
    attempts: 0,
    max_attempts: 5,
  });
  await redis.hset(`subscriber:${id}`, { secret: "shh" });

  for (let i = 0; i < 5; i++) {
    const status = await redis.hget(`delivery:${id}`, "status");
    if (status === "completed") break;
    // re-arm as due so we skip the real backoff wait
    await redis.zadd("retry:zset", Date.now(), id);
    await signDueEntries();
  }

  assert.strictEqual(await redis.hget(`delivery:${id}`, "status"), "completed");
  assert.strictEqual(callCount, 3);

  server.close();
});

test("delivery fails until max attempts reached", async () => {
  let callCount = 0;
  const server = createServer((req, res) => {
    callCount += 1;
    res.writeHead(500);
    res.end();
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://localhost:${port}`;

  const id = "retry-dead";
  await redis.del(`delivery:${id}`);
  await redis.hset(`delivery:${id}`, {
    eventId: "e1",
    subscriberId: id,
    url: baseUrl,
    payload: "hello",
    attempts: 0,
    max_attempts: 3,
  });
  await redis.hset(`subscriber:${id}`, { secret: "shh" });

  for (let i = 0; i < 5; i++) {
    const status = await redis.hget(`delivery:${id}`, "status");
    if (status === "dead") break;
    // re-arm as due so we skip the real backoff wait
    await redis.zadd("retry:zset", Date.now(), id);
    await signDueEntries();
  }

  assert.strictEqual(await redis.hget(`delivery:${id}`, "status"), "dead");
  assert.strictEqual(callCount, 3);

  server.close();
});

test("verify() rejects a signature with the wrong payload, secret, or length", () => {
  const data = { payload: "example payload" };
  const secret = crypto.randomBytes(10).toString("hex");
  const receivedSignature = sign(data.payload, secret);

  assert.strictEqual(verify("fake payload", secret, receivedSignature), false);
  assert.strictEqual(
    verify(data.payload, "fake secret", receivedSignature),
    false,
  );
  assert.strictEqual(verify(data.payload, secret, "fake signature"), false);
});

test("verify() accepts a signature that matches the payload", () => {
  const data = { payload: "example payload" };
  const secret = crypto.randomBytes(10).toString("hex");

  const receivedSignature = sign(data.payload, secret);
  assert.strictEqual(verify(data.payload, secret, receivedSignature), true);
});
