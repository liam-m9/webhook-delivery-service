import { signDueEntries } from "./dispatcher.ts";

console.log(`Dispatcher starting... `);

let stopped = false;

async function loop() {
  while (!stopped) {
    try {
      await signDueEntries();
    } catch (error: unknown) {
      if (error instanceof Error)
        console.error("Entry sign error", error.message);
    }
    // if still running, pause before next signDueEntries() call 
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const loopPromise = loop();

process.on("SIGINT", async () => {
  stopped = true;
  await loopPromise;
  console.log("Ended process");
  process.exit();
});

process.on("SIGTERM", async () => {
  stopped = true;
  await loopPromise;
  console.log("Ended process");
  process.exit();
});
