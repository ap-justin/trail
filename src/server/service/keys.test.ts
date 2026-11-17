import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { actor, apiKey, product, project } from "../db/schema.js";
import { NotFoundError, ValidationError } from "./errors.js";
import {
  authenticateKey,
  createBot,
  createHuman,
  createKey,
  editKeyScope,
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
  const human = createHuman(db, { displayName: "Pat", githubId: 42 });
  expect(human).toMatchObject({ kind: "human", githubId: 42 });
  const keys = db.select().from(apiKey).all();
  expect(keys.some((r) => r.actorId === human.id)).toBe(false);
});

describe("a key's scope", () => {
  const owner = createBot(db, "scope owner").actor;
  const addProject = (key: string) =>
    db
      .insert(product)
      .values({ key, name: key, createdBy: owner.id })
      .returning()
      .get();
  const bta = addProject("BTA");
  const ops = addProject("OPS");

  test("a key minted without a scope reaches every project with every action", () => {
    const { key } = createBot(db, "unscoped");
    expect(authenticateKey(db, key)?.scope).toEqual({
      products: null,
      projects: [],
      actions: null,
    });
  });

  test("createBot stores the projects by id and the actions, both read back on the key", () => {
    const { actor, key } = createBot(db, "gamma-scoped", {
      scope: { products: ["bta", "OPS"], actions: ["comments", "read"] },
    });
    expect(authenticateKey(db, key)).toEqual({
      ...actor,
      scope: {
        products: [
          { id: bta.id, key: "BTA" },
          { id: ops.id, key: "OPS" },
        ],
        projects: [],
        actions: ["read", "comments"],
      },
    });
  });

  test("createKey mints a scoped key beside the bot's unscoped one", () => {
    const { actor, key: wide } = createBot(db, "two keys");
    const { key: narrow } = createKey(db, actor.id, { actions: ["issues"] });
    expect(authenticateKey(db, narrow)?.scope).toEqual({
      products: null,
      projects: [],
      actions: ["issues"],
    });
    expect(authenticateKey(db, wide)?.scope).toEqual({
      products: null,
      projects: [],
      actions: null,
    });
  });

  test("repeated project keys and actions are stored once", () => {
    const { key } = createBot(db, "repeats", {
      scope: { products: ["BTA", "bta", "Bta"], actions: ["read", "read"] },
    });
    expect(authenticateKey(db, key)?.scope).toEqual({
      products: [{ id: bta.id, key: "BTA" }],
      projects: [],
      actions: ["read"],
    });
  });

  test("an unknown project key is refused by name, and no bot is created", () => {
    expect(() =>
      createBot(db, "refused bot", {
        scope: { products: ["BTA", "NOPE", "zz"] },
      }),
    ).toThrow(
      new ValidationError(
        "no product NOPE, ZZ: scope the key to products that exist, which are BTA, OPS",
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
      "products",
      { products: [] },
      "products must name at least one product: leave it out for a key that reaches every product",
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
      scope: { products: ["OPS", "BTA"], actions: ["admin"] },
    });
    const listed = listKeys(db).filter((k) => k.actorId === actor.id);
    expect(listed.map((k) => k.scope)).toEqual([
      { products: ["BTA", "OPS"], projects: [], actions: ["admin"] },
    ]);
    const unscoped = listKeys(db).find((k) => k.actorId === owner.id);
    expect(unscoped?.scope).toEqual({
      products: null,
      projects: null,
      actions: null,
    });
  });
});

describe("a key scoped to projects", () => {
  const lead = createBot(db, "project lead").actor;
  const addProduct = (key: string) =>
    db
      .insert(product)
      .values({ key, name: key, createdBy: lead.id })
      .returning()
      .get();
  const addGroup = (slug: string) =>
    db
      .insert(project)
      .values({ slug, name: slug, leadId: lead.id, createdBy: lead.id })
      .returning()
      .get();
  // in beforeAll, so the products listed by the describe above stay its own
  let atl: typeof product.$inferSelect;
  let recon: typeof project.$inferSelect;
  let survey: typeof project.$inferSelect;
  beforeAll(() => {
    atl = addProduct("ATL");
    recon = addGroup("recon");
    survey = addGroup("survey");
  });

  test("a key minted with projects only reaches no product of its own, and its projects by id and slug", () => {
    const { key } = createBot(db, "alpha", { scope: { projects: ["recon"] } });
    expect(authenticateKey(db, key)?.scope).toEqual({
      products: [],
      projects: [{ id: recon.id, slug: "recon" }],
      actions: null,
    });
  });

  test("a key with products and projects reaches both, and lists them by key and slug", () => {
    const { actor, key } = createBot(db, "beta", {
      scope: { products: ["atl"], projects: ["survey", "recon", "recon"] },
    });
    expect(authenticateKey(db, key)?.scope).toEqual({
      products: [{ id: atl.id, key: "ATL" }],
      projects: [
        { id: recon.id, slug: "recon" },
        { id: survey.id, slug: "survey" },
      ],
      actions: null,
    });
    expect(
      listKeys(db)
        .filter((k) => k.actorId === actor.id)
        .map((k) => k.scope),
    ).toEqual([
      { products: ["ATL"], projects: ["recon", "survey"], actions: null },
    ]);
  });

  test("a project-only key lists products as an empty list, never null", () => {
    const { actor } = createBot(db, "gamma", {
      scope: { projects: ["recon"] },
    });
    expect(
      listKeys(db)
        .filter((k) => k.actorId === actor.id)
        .map((k) => k.scope),
    ).toEqual([{ products: [], projects: ["recon"], actions: null }]);
  });

  test("an unknown slug is refused naming the projects that exist, and no bot is created", () => {
    expect(() =>
      createBot(db, "delta", { scope: { projects: ["recon", "nope"] } }),
    ).toThrow(
      new ValidationError(
        "no project nope: scope the key to projects that exist, by slug, which are recon, survey",
      ),
    );
    expect(
      db
        .select()
        .from(actor)
        .all()
        .some((a) => a.displayName === "delta"),
    ).toBe(false);
  });

  test("an empty projects list is refused", () => {
    expect(() => createKey(db, lead.id, { projects: [] })).toThrow(
      new ValidationError(
        "projects must name at least one project: leave it out for a key that isn't limited to projects",
      ),
    );
  });
});

describe("editKeyScope", () => {
  const owner = createBot(db, "edit owner").actor;
  // BTA is the first describe's, recon the second's
  let recon: typeof project.$inferSelect;
  beforeAll(() => {
    recon = db
      .select()
      .from(project)
      .all()
      .find((p) => p.slug === "recon") as typeof project.$inferSelect;
  });
  const prefixOf = (key: string) => key.slice(6, 14);
  const keyWith = (scope: Parameters<typeof createKey>[2]) =>
    createKey(db, owner.id, scope).key;

  test("adds a project and a product to a restricted key in one write, and returns the new scope", () => {
    const key = keyWith({ products: ["ATL"] });
    expect(
      editKeyScope(db, prefixOf(key), {
        addProjects: ["recon"],
        addProducts: ["bta"],
      }),
    ).toEqual({ products: ["ATL", "BTA"], projects: ["recon"], actions: null });
    expect(authenticateKey(db, key)?.scope.projects).toEqual([
      { id: recon.id, slug: "recon" },
    ]);
  });

  test("removes a product, leaving the key on its project", () => {
    const key = keyWith({ products: ["BTA"], projects: ["recon"] });
    expect(
      editKeyScope(db, prefixOf(key), { removeProducts: ["bta"] }),
    ).toEqual({ products: [], projects: ["recon"], actions: null });
    expect(authenticateKey(db, key)?.scope).toMatchObject({
      products: [],
      projects: [{ id: recon.id, slug: "recon" }],
    });
  });

  test("removes a project, leaving the key on its product", () => {
    const key = keyWith({ products: ["BTA"], projects: ["recon"] });
    expect(
      editKeyScope(db, prefixOf(key), { removeProjects: ["recon"] }),
    ).toEqual({ products: ["BTA"], projects: [], actions: null });
  });

  test("refuses to remove the last of a restricted key's reach, which would widen it to everything", () => {
    const key = keyWith({ projects: ["recon"], actions: ["read"] });
    expect(() =>
      editKeyScope(db, prefixOf(key), { removeProjects: ["recon"] }),
    ).toThrow(
      new ValidationError(
        "that edit leaves the key with no product and no project, and a key with neither reaches everything: add a product or project in the same edit, or revoke the key with `trail key revoke " +
          prefixOf(key) +
          "`",
      ),
    );
    expect(authenticateKey(db, key)?.scope.projects).toEqual([
      { id: recon.id, slug: "recon" },
    ]);
  });

  test("refuses to add to an unrestricted key, which already reaches everything", () => {
    const key = keyWith({});
    expect(() =>
      editKeyScope(db, prefixOf(key), { addProjects: ["recon"] }),
    ).toThrow(
      new ValidationError(
        "this key is unrestricted and already reaches every product and project, so adding to it changes nothing: mint a key limited to what it should reach with `trail key create`, and revoke this one",
      ),
    );
    expect(authenticateKey(db, key)?.scope).toEqual({
      products: null,
      projects: [],
      actions: null,
    });
  });

  test("adding what the key has and removing what it hasn't change nothing and return the scope", () => {
    const key = keyWith({ products: ["BTA"], projects: ["recon"] });
    expect(
      editKeyScope(db, prefixOf(key), {
        addProjects: ["recon"],
        removeProducts: ["ATL"],
        removeProjects: ["survey"],
      }),
    ).toEqual({ products: ["BTA"], projects: ["recon"], actions: null });
    const open = keyWith({});
    expect(
      editKeyScope(db, prefixOf(open), { removeProjects: ["recon"] }),
    ).toEqual({ products: null, projects: null, actions: null });
  });

  test("refuses an unknown slug or product key to add, naming those that exist", () => {
    const key = keyWith({ products: ["BTA"] });
    expect(() =>
      editKeyScope(db, prefixOf(key), { addProjects: ["nope"] }),
    ).toThrow(/^no project nope: scope the key to projects that exist/);
    expect(() =>
      editKeyScope(db, prefixOf(key), { addProducts: ["NOPE"] }),
    ).toThrow(/^no product NOPE: scope the key to products that exist/);
  });

  test("an unknown or revoked prefix is a NotFoundError", () => {
    expect(() =>
      editKeyScope(db, "00000000", { addProjects: ["recon"] }),
    ).toThrow(NotFoundError);
    const key = keyWith({ products: ["BTA"] });
    revokeKey(db, prefixOf(key));
    expect(() =>
      editKeyScope(db, prefixOf(key), { addProjects: ["recon"] }),
    ).toThrow(NotFoundError);
  });
});
