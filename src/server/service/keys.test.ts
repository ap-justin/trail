import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { apiKey } from "../db/schema.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { createBot, createHuman, resolveKey, revokeKey } from "./keys.js";

const dir = mkdtempSync(join(tmpdir(), "trail-keys-"));
const db = openDatabase(join(dir, "trail.db"));
migrate(db);
afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a new bot's key resolves to that bot", () => {
  const { actor, key } = createBot(db, "builder");
  expect(actor).toMatchObject({ kind: "bot", displayName: "builder" });
  expect(key).toMatch(/^trail_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
  expect(resolveKey(db, key)).toEqual(actor);
});

test("only the prefix and the sha256 of the full key are stored", () => {
  const { actor, key } = createBot(db, "stored");
  const rows = db.select().from(apiKey).all();
  const row = rows.find((r) => r.actorId === actor.id);
  expect(row?.prefix).toBe(key.slice(6, 14));
  expect(row?.hash).toBe(createHash("sha256").update(key).digest("hex"));
  const secret = key.slice(15);
  expect(JSON.stringify(rows)).not.toContain(secret);
});

test("an unknown or malformed key resolves to null", () => {
  const { key } = createBot(db, "other");
  const unknownPrefix = `trail_00000000_${key.slice(15)}`;
  const wrongSecret = `${key.slice(0, 15)}${"A".repeat(43)}`;
  for (const token of [unknownPrefix, wrongSecret, "", "trail_x", `${key}x`]) {
    expect(resolveKey(db, token)).toBeNull();
  }
});

test("a revoked key stops resolving, and revoking again is a no-op", () => {
  const { key, actor } = createBot(db, "revoked");
  const prefix = key.slice(6, 14);
  expect(resolveKey(db, key)).toEqual(actor);
  const first = revokeKey(db, prefix);
  expect(resolveKey(db, key)).toBeNull();
  const again = revokeKey(db, prefix);
  expect(again.revokedAt).toEqual(first.revokedAt);
});

test("revoking one bot's key leaves another bot's key resolving", () => {
  const keep = createBot(db, "keeper");
  const lose = createBot(db, "loser");
  expect(resolveKey(db, lose.key)).toEqual(lose.actor);
  revokeKey(db, lose.key.slice(6, 14));
  expect(resolveKey(db, lose.key)).toBeNull();
  expect(resolveKey(db, keep.key)).toEqual(keep.actor);
});

test("revoking an unknown prefix is a NotFoundError", () => {
  expect(() => revokeKey(db, "ffffffff")).toThrow(NotFoundError);
});

test("a bot needs a display name", () => {
  expect(() => createBot(db, "  ")).toThrow(ValidationError);
});

test("a human can be created with a GitHub id and has no key", () => {
  const human = createHuman(db, { displayName: "Justin", githubId: 42 });
  expect(human).toMatchObject({ kind: "human", githubId: 42 });
  const keys = db.select().from(apiKey).all();
  expect(keys.some((r) => r.actorId === human.id)).toBe(false);
});
