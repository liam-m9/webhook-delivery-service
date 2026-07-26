import "dotenv/config";

const urlInput =
  process.argv[2] ?? `http://localhost:${process.env.SERVER_PORT}/events`;

function createPayload() {
  const examplePayload = {
    type: "payment.succeeded",
    orderId: 123,
    amount: 50,
    currency: "gbp",
  };
  return examplePayload;
}

async function sendEvent() {
  try {
    await fetch(urlInput, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createPayload()),
    });
    console.log(`Posted to url: ${urlInput}`);
  } catch (error) {
    console.log(error);
  }
}

await sendEvent();
