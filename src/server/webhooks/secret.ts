import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * A webhook's signing secret has to come back out to sign with, so it is
 * encrypted rather than hashed: AES-256-GCM under a key derived from the
 * server's own BETTER_AUTH_SECRET, which lives in the environment and not in
 * the database. A copy of the database alone (a Litestream replica, a volume
 * snapshot) gives no secret away. Changing BETTER_AUTH_SECRET makes every
 * stored secret unreadable; each bot then sets a new one with a rotate call.
 */
export type SecretKey = Buffer;

export function deriveSecretKey(serverSecret: string): SecretKey {
  return Buffer.from(
    hkdfSync(
      "sha256",
      serverSecret,
      "trail",
      "trail webhook signing secrets v1",
      32,
    ),
  );
}

// the subscription id is bound in, so a ciphertext copied to another row fails to open
export function sealSecret(
  key: SecretKey,
  subscriptionId: string,
  secret: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(subscriptionId));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data]
    .map((part) => (typeof part === "string" ? part : part.toString("base64")))
    .join(".");
}

/** The secret, or null when the key or the row doesn't match what sealed it. */
export function openSecret(
  key: SecretKey,
  subscriptionId: string,
  sealed: string,
): string | null {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAAD(Buffer.from(subscriptionId));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
