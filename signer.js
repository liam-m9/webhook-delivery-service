import crypto from "crypto";

// payload = message, secret = key
export function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function verify(payload, secret, receivedSignature) {
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

