import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { deriveSecretKey, openSecret, sealSecret } from "./secret.js";
import { signedHeaders } from "./signing.js";

const key = deriveSecretKey("a-server-secret-that-is-at-least-32-chars");

test("a sealed secret opens only under its key and its row", () => {
  const sealed = sealSecret(key, "sub-1", "whsec_plain_secret_value");
  expect(sealed).not.toContain("whsec_plain_secret_value");
  expect(openSecret(key, "sub-1", sealed)).toBe("whsec_plain_secret_value");
  expect(openSecret(key, "sub-2", sealed)).toBeNull();
  expect(
    openSecret(
      deriveSecretKey("another-server-secret-of-32-chars-ok"),
      "sub-1",
      sealed,
    ),
  ).toBeNull();
  expect(openSecret(key, "sub-1", "garbage")).toBeNull();
  expect(openSecret(key, "sub-1", `${sealed.slice(0, -2)}AA`)).toBeNull();
});

test("one secret seals to different text each time", () => {
  expect(sealSecret(key, "s", "same-secret-same-secret")).not.toBe(
    sealSecret(key, "s", "same-secret-same-secret"),
  );
});

test("the signature is sha256= of the HMAC over timestamp.deliveryId.body", () => {
  const headers = signedHeaders({
    secret: "s3cret",
    deliveryId: "delivery-1",
    body: '{"type":"trail.ping"}',
    now: 1_700_000_000_999,
  });
  expect(headers["x-openbot-timestamp"]).toBe("1700000000");
  expect(headers["x-openbot-delivery-id"]).toBe("delivery-1");
  expect(headers["content-type"]).toBe("application/json");
  expect(headers["x-openbot-signature"]).toBe(
    `sha256=${createHmac("sha256", "s3cret").update('1700000000.delivery-1.{"type":"trail.ping"}').digest("hex")}`,
  );
});

// computed outside this code: printf '1700000000.dlv_0123.{"type":"trail.ping"}' | openssl dgst -sha256 -hmac whsec_known_answer_secret
// the format is what OpenBot receivers verify, so a change here breaks every one of them
test("a fixed secret, id, time and body sign to a known signature", () => {
  expect(
    signedHeaders({
      secret: "whsec_known_answer_secret",
      deliveryId: "dlv_0123",
      body: '{"type":"trail.ping"}',
      now: 1_700_000_000_000,
    }),
  ).toEqual({
    "content-type": "application/json",
    "x-openbot-timestamp": "1700000000",
    "x-openbot-delivery-id": "dlv_0123",
    "x-openbot-signature":
      "sha256=3fad666fa92011587e497c9f233bbbd5b9cf44861002873dd778e69a768394ce",
  });
});
