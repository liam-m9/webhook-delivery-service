import "dotenv/config";
import { verify, buildSignedPayload } from "./signer.ts";
import express from "express";
import crypto from "crypto";
import redis from "./redis.ts";

const app = express();

app.use(express.json());

let callCount = 0;

function checkIfFailed() {
  callCount += 1;
  const threshold = Number(process.env.FAIL_COUNT || 0);
  return callCount <= threshold;
}

function isDown() {
  return process.env.DOWN === "true";
}

app.post("/", async (req, res) => {
  try {
    if (isDown()) {
      return res.status(500).json({ message: "internal server error" });
    }
    if (checkIfFailed()) {
      return res.status(500).json({ message: "internal server error" });
    }

    const subscriberSecret = process.env.SUBSCRIBER_SECRET;

    if (!subscriberSecret) {
      throw new Error("missing subscriber secret environment variable");
    }

    const { payload, timestamp, nonce, signature } = req.body;

    if (!payload || !timestamp || !nonce || !signature) {
      return res.status(400).json({ message: "missing signature components" });
    }

    const stringToVerify = buildSignedPayload(payload, timestamp, nonce);
    const isVerified = verify(stringToVerify, subscriberSecret, signature);

    if (!isVerified) {
      return res.status(401).json({ message: "invalid signature" });
    }

    const fiveMins = 5 * 60 * 1000;
    const timeDifference = Math.abs(Date.now() - timestamp);

    if (timeDifference > fiveMins) {
      return res.status(400).json({ message: "timestamp out of tolerance" });
    }
    
    const nonceKey = `nonce:${nonce}`;
    const result = await redis.set(nonceKey, "1", "EX", 300, "NX");

    if (result === null) {
      // This means the key already existed, so it's a replay
      return res.status(400).json({ message: "potential replay attack" });
    }
    console.log("webhook received and verified");
    res.status(200).json({ message: "signature verified" });

  } catch (error) {
    if (error instanceof Error) {
      console.error("Webhook processing error:", error.message);
    } else {
      console.error("An unknown error occurred:", error);
    }
    res.status(500).json({ error: "internal server failure" });
  }
});

app.listen(process.env.RECEIVER_PORT, () => {
  console.log(`listening on port ${process.env.RECEIVER_PORT}`);
});
