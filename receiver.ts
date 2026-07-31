import "dotenv/config";
import { verify } from "./signer.ts";
import express from "express";

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

    const subscriberSecret = process.env.SUBSCRIBER_SECRET

    if (!subscriberSecret) {
      throw new Error('missing subscriber secret environment variable')
    }

    const isValid = verify(
      req.body.payload,
      subscriberSecret,
      req.body.hashedPayload,
    );

    if (isValid) {
      console.log("webhook received");
      res.status(200).json({ message: "signature verified" });
    } else {
      res.status(401).json({ message: "invalid signature" });
    }
  } catch (error) {
    res.status(500).json({ error: "internal server error" });
    console.log(error);
  }
});

app.listen(process.env.RECEIVER_PORT, () => {
  console.log(`listening on port ${process.env.RECEIVER_PORT}`);
});
