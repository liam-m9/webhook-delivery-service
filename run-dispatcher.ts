import { signDueEntries } from "./dispatcher.ts";

console.log(`Dispatcher starting... `);

let currentTick: Promise<void> | null = null;

const intervalId = setInterval(async () => {
  try {
    currentTick = signDueEntries();
    await currentTick;
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error("Entry sign error", error.message);
    }
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
