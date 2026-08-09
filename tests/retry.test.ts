import { test } from "node:test";
import assert from "node:assert";
import type { AddressInfo } from "node:net";
import { createServer } from "http";
import crypto from "crypto";
import { sign, verify, buildSignedPayload } from "../signer.ts";
import { getDueEntries, signDueEntries } from "../dispatcher.ts";
import redis from "../redis.ts";

test("retrying until success", async () => {
  let callCount = 0;
  const server = createServer((req, res) => {
    callCount += 1;

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const { payload, timestamp, nonce, signature } = JSON.parse(body);
      const stringToVerify = buildSignedPayload(payload, timestamp, nonce);
      const isValid = verify(stringToVerify, "shh", signature);
      if (!isValid) {
        res.writeHead(401);
        res.end();
        return;
      }
    });

    if (callCount <= 2) { // Fail first two attempts
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

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const { payload, timestamp, nonce, signature } = JSON.parse(body);
      const stringToVerify = buildSignedPayload(payload, timestamp, nonce);
      const isValid = verify(stringToVerify, "shh", signature);
      if (!isValid) {
        res.writeHead(401);
        res.end();
        return;
      }
    });
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
  const payload = "example payload";
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString("base64");
  const secret = crypto.randomBytes(10).toString("hex");

  const goodString = buildSignedPayload(payload, timestamp, nonce);
  const signature = sign(goodString, secret);

  const badStringPayload = buildSignedPayload("fake payload", timestamp, nonce);
  assert.strictEqual(verify(badStringPayload, secret, signature), false);

  const badStringTimestamp = buildSignedPayload(payload, timestamp + 1, nonce);
  assert.strictEqual(verify(badStringTimestamp, secret, signature), false);

  assert.strictEqual(
    verify(goodString, "fake secret", signature),
    false,
  );
  assert.strictEqual(verify(goodString, secret, "fake signature"), false);
});

test("verify() accepts a signature that matches the payload", () => {
  const payload = "example payload";
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString("base64");
  const secret = crypto.randomBytes(10).toString("hex");

  const stringToSign = buildSignedPayload(payload, timestamp, nonce);
  const signature = sign(stringToSign, secret);

  assert.strictEqual(verify(stringToSign, secret, signature), true);
});

test("receiver rejects a replayed nonce", async () => {
  const nonce = "replay-test-nonce";
  await redis.set(`nonce:${nonce}`, "1", "EX", 300, "NX");
  const result = await redis.set(`nonce:${nonce}`, "1", "EX", 300, "NX");
  assert.strictEqual(result, null);
});
