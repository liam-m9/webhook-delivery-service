import "dotenv/config";
import redis from "./redis.ts";
import crypto from "crypto";
import express from "express";

const app = express();

app.use(express.json());

app.post("/subscriptions", async (req, res) => {
  try {
    const url = req.body.url;
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(10).toString("hex");
    if (url == null) {
      return res.status(400).json({ error: "client failed to send url" });
    }
    await redis.hset(`subscriber:${id}`, { url: url, secret: secret });
    await redis.sadd("all_subscribers", id);
    res.status(200).json({ id: id, url: url, secret: secret });
  } catch (error) {
    res.status(500).json({ error: "internal server failure" });
  }
});

app.post("/events", async (req, res) => {
  try {
    const payload = JSON.stringify(req.body);
    const eventId = crypto.randomUUID();
    const allSubIds = await redis.smembers("all_subscribers");
    let totalSubCount = 0;
    // loop sub id, look up url, store a delivery record and queue it for the dispatcher
    for (const id of allSubIds) {
      totalSubCount += 1;
      let deliveryId = crypto.randomUUID();
      let subUrl = await redis.hget(`subscriber:${id}`, "url");
      await redis.hset(`delivery:${deliveryId}`, {
        eventId: eventId,
        subscriberId: id,
        url: subUrl,
        payload: payload,
        attempts: 0,
        max_attempts: 5,
        status: "pending",
      });
      // add delivery job to sorted set with their score (ranked by time)
      await redis.zadd("retry:zset", Date.now(), deliveryId);
    }
    res.status(200).json({ eventId: eventId, totalSubCount: totalSubCount });
    console.log("event ingested");
  } catch (error) {
    res.status(500).json({ error: "internal server error" });
    console.log(error);
  }
});

app.listen(process.env.SERVER_PORT, () => {
  console.log(`listening on port ${process.env.SERVER_PORT}`);
});
