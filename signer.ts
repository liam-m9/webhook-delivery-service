import crypto from "crypto";

// payload = message, secret = key
export function sign(payload: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verify(payload: string, secret: string, receivedSignature: string) {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  if (signature.length != receivedSignature.length) return false;

  const isValid = crypto.timingSafeEqual(
    Buffer.from(receivedSignature),
    Buffer.from(signature),
  );
  return isValid;
}

