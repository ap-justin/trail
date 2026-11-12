import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { actor, apiKey, project } from "../db/schema.js";
import { NotFoundError, ValidationError } from "./errors.js";
import {
  authenticateKey,
  createBot,
  createHuman,
  createKey,
  listKeys,
  resolveKey,
  revokeKey,
} from "./keys.js";

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

describe("a key's scope", () => {
  const owner = createBot(db, "scope owner").actor;
  const addProject = (key: string) =>
    db
      .insert(project)
      .values({ key, name: key, createdBy: owner.id })
      .returning()
      .get();
  const bgp = addProject("BGP");
  const ops = addProject("OPS");

  test("a key minted without a scope reaches every project with every action", () => {
    const { key } = createBot(db, "unscoped");
    expect(authenticateKey(db, key)?.scope).toEqual({
      projects: null,
      actions: null,
    });
  });

  test("createBot stores the projects by id and the actions, both read back on the key", () => {
    const { actor, key } = createBot(db, "bg-ivy", {
      scope: { projects: ["bgp", "OPS"], actions: ["comments", "read"] },
    });
    expect(authenticateKey(db, key)).toEqual({
      ...actor,
      scope: {
        projects: [
          { id: bgp.id, key: "BGP" },
          { id: ops.id, key: "OPS" },
        ],
        actions: ["read", "comments"],
      },
    });
  });

  test("createKey mints a scoped key beside the bot's unscoped one", () => {
    const { actor, key: wide } = createBot(db, "two keys");
    const { key: narrow } = createKey(db, actor.id, { actions: ["issues"] });
    expect(authenticateKey(db, narrow)?.scope).toEqual({
      projects: null,
      actions: ["issues"],
    });
    expect(authenticateKey(db, wide)?.scope).toEqual({
      projects: null,
      actions: null,
    });
  });

  test("repeated project keys and actions are stored once", () => {
    const { key } = createBot(db, "repeats", {
      scope: { projects: ["BGP", "bgp", "Bgp"], actions: ["read", "read"] },
    });
    expect(authenticateKey(db, key)?.scope).toEqual({
      projects: [{ id: bgp.id, key: "BGP" }],
      actions: ["read"],
    });
  });

  test("an unknown project key is refused by name, and no bot is created", () => {
    expect(() =>
      createBot(db, "refused bot", {
        scope: { projects: ["BGP", "NOPE", "zz"] },
      }),
    ).toThrow(
      new ValidationError(
        "no project with key NOPE, ZZ: scope the key to the keys of existing projects, like TRL",
      ),
    );
    // listKeys joins api_key, so an orphaned bot row is only visible on actor
    expect(
      db
        .select()
        .from(actor)
        .all()
        .some((a) => a.displayName === "refused bot"),
    ).toBe(false);
  });

  test("an unknown action is refused, listing the five", () => {
    expect(() =>
      createKey(db, owner.id, { actions: ["read", "write"] }),
    ).toThrow(
      new ValidationError(
        'unknown action "write": a key\'s actions are read, issues, comments, status_updates and admin',
      ),
    );
  });

  test.each([
    [
      "projects",
      { projects: [] },
      "projects must name at least one project: leave it out for a key that reaches every project",
    ],
    [
      "actions",
      { actions: [] },
      "actions must name at least one action: leave it out for a key with every action",
    ],
  ])("an empty %s list is refused", (_, scope, message) => {
    expect(() => createKey(db, owner.id, scope)).toThrow(
      new ValidationError(message),
    );
  });

  test("listKeys shows each key's scope by project key", () => {
    const { actor } = createBot(db, "listed scope", {
      scope: { projects: ["OPS", "BGP"], actions: ["admin"] },
    });
    const listed = listKeys(db).filter((k) => k.actorId === actor.id);
    expect(listed.map((k) => k.scope)).toEqual([
      { projects: ["BGP", "OPS"], actions: ["admin"] },
    ]);
    const unscoped = listKeys(db).find((k) => k.actorId === owner.id);
    expect(unscoped?.scope).toEqual({ projects: null, actions: null });
  });
});
