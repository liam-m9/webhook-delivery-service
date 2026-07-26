import { signDueEntries } from "./dispatcher.js";

console.log(`Dispatcher starting... `);

let currentTick = null;

const intervalId = setInterval(async () => {
  try {
    currentTick = signDueEntries();
    await currentTick;
  } catch (error) {
    console.error("Entry sign error", error.message);
  }
}, 1000);

process.on("SIGINT", async () => {
  clearInterval(intervalId);
  await currentTick;
  console.log("Ended process");
  process.exit();
});

process.on("SIGTERM", async () => {
  clearInterval(intervalId);
  await currentTick;
  console.log("Ended process");
  process.exit();
});
