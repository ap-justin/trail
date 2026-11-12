import { createHmac } from "node:crypto";

/**
 * The headers of OpenBot's signed webhook: the signature is
 * `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<deliveryId>.<raw body>`
 * under the secret, with the timestamp in unix seconds.
 */
export function signedHeaders({
  secret,
  deliveryId,
  body,
  now,
}: {
  secret: string;
  deliveryId: string;
  body: string;
  now: number;
}): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${deliveryId}.${body}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-openbot-timestamp": timestamp,
    "x-openbot-delivery-id": deliveryId,
    "x-openbot-signature": `sha256=${signature}`,
  };
}
