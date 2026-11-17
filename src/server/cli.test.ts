import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { migrate, openDatabase } from "./db/client.js";
import {
  actor,
  apiKey,
  product,
  project,
  projectProduct,
  webhookSubscription,
} from "./db/schema.js";
import {
  createBot,
  createHuman,
  listKeys,
  resolveKey,
} from "./service/keys.js";

const dir = mkdtempSync(join(tmpdir(), "trail-cli-"));
const DATABASE_PATH = join(dir, "trail.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// as the server or `pnpm db:migrate` would leave it; the CLI never creates the file
const created = openDatabase(DATABASE_PATH);
migrate(created);
created.$client.close();

function runAt(path: string, argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runCli(argv, {
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    env: { DATABASE_PATH: path },
  });
  return { code, stdout, stderr };
}

const run = (...argv: string[]) => runAt(DATABASE_PATH, argv);

function withDb<T>(fn: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(DATABASE_PATH);
  try {
    return fn(db);
  } finally {
    db.$client.close();
  }
}

function createdKey(stdout: string): string {
  const key = /^key\s+(\S+)$/m.exec(stdout)?.[1];
  if (!key) throw new Error(`no key line in ${JSON.stringify(stdout)}`);
  return key;
}

test("bot create prints the bot's id and a key that resolves to it", () => {
  const { code, stdout, stderr } = run("bot", "create", "builder");
  expect(code).toBe(0);
  const id = /^actor\s+(\S+)$/m.exec(stdout)?.[1];
  const bot = withDb((db) => resolveKey(db, createdKey(stdout)));
  expect(bot).toMatchObject({ id, kind: "bot", displayName: "builder" });
  expect(stderr).toMatch(/can't be shown again/);
});

test.each([
  ["the prefix", (key: string) => key.slice(6, 14)],
  ["the full key", (key: string) => key],
  ["trail_<prefix>_", (key: string) => key.slice(0, 15)],
])("key revoke by %s stops the key resolving", (form, cut) => {
  const key = createdKey(run("bot", "create", `revoked by ${form}`).stdout);
  const { code, stdout } = run("key", "revoke", cut(key));
  expect(code).toBe(0);
  expect(stdout).toContain(`revoked trail_${key.slice(6, 14)}`);
  expect(withDb((db) => resolveKey(db, key))).toBeNull();
});

/** A webhook row of the bot's, recording the key with `recorded`'s prefix or none. */
function webhookOf(
  actorId: string,
  recorded: string | null,
  kind: "activity" | "inbox",
  url: string,
) {
  return withDb((db) => {
    const apiKeyId =
      recorded === null
        ? null
        : db
            .select({ id: apiKey.id })
            .from(apiKey)
            .where(eq(apiKey.prefix, recorded.slice(6, 14)))
            .get()?.id;
    return db
      .insert(webhookSubscription)
      .values({ actorId, url, kind, secretCipher: "sealed", apiKeyId })
      .returning({ id: webhookSubscription.id })
      .get().id;
  });
}

const actorOf = (stdout: string) =>
  /^actor\s+(\S+)$/m.exec(stdout)?.[1] as string;

const moveHint =
  "trail: to move a webhook to another key, call update_webhook (PATCH /api/v1/webhooks/{id}) or rotate_webhook_secret with that key (the key checked becomes the one that last changed the webhook)\n";

test("key revoke prints a line per webhook the key recorded, by URL origin, and on stderr how to move them", () => {
  const made = run("bot", "create", "revoke lists", "--label", "lister");
  const key = createdKey(made.stdout);
  const bot = actorOf(made.stdout);
  run("key", "create", "lister");
  const activity = webhookOf(
    bot,
    key,
    "activity",
    "https://hooks.example.com/a?token=s3cret",
  );
  const inbox = webhookOf(
    bot,
    key,
    "inbox",
    "https://inbox.example.com:8443/b/c",
  );
  const { code, stdout, stderr } = run("key", "revoke", key.slice(6, 14));
  expect(code).toBe(0);
  const lines = stdout.split("\n");
  expect(lines[0]).toMatch(
    new RegExp(`^revoked trail_${key.slice(6, 14)} \\(actor ${bot}\\) at `),
  );
  expect(lines.slice(1).toSorted()).toEqual(
    [
      "",
      `stopped webhook ${activity} (activity) to https://hooks.example.com`,
      `stopped webhook ${inbox} (inbox) to https://inbox.example.com:8443`,
    ].toSorted(),
  );
  expect(stderr).toBe(moveHint);
});

test("key revoke of a bot's last live key lists its webhooks recording no key and says to mint a key first", () => {
  const made = run("bot", "create", "revoke last", "--label", "last-one");
  const key = createdKey(made.stdout);
  const bot = actorOf(made.stdout);
  const hook = webhookOf(bot, null, "activity", "https://last.example.com/x");
  const { code, stdout, stderr } = run("key", "revoke", key.slice(6, 14));
  expect(code).toBe(0);
  expect(stdout.split("\n").slice(1)).toEqual([
    `stopped webhook ${hook} (activity) to https://last.example.com`,
    "",
  ]);
  expect(stderr).toBe(
    "trail: this bot has no live key left: mint one first with `trail key create last-one`\n" +
      moveHint,
  );
});

test("key revoke that stops no webhook prints only the revoked line", () => {
  const made = run("bot", "create", "revoke quiet");
  const key = createdKey(made.stdout);
  webhookOf(actorOf(made.stdout), null, "activity", "https://q.example.com");
  run("key", "create", actorOf(made.stdout));
  const { code, stdout, stderr } = run("key", "revoke", key.slice(6, 14));
  expect(code).toBe(0);
  expect(stdout).toMatch(/^revoked trail_[0-9a-f]{8} \(actor \S+\) at \S+\n$/);
  expect(stderr).toBe("");
});

test("bot create --key-only prints only the key on stdout, the rest on stderr", () => {
  const { code, stdout, stderr } = run(
    "bot",
    "create",
    "quiet",
    "--label",
    "agent-quiet",
    "--key-only",
  );
  expect(code).toBe(0);
  expect(stdout).toMatch(/^trail_[0-9a-f]{8}_[A-Za-z0-9_-]{43}\n$/);
  const bot = withDb((db) => resolveKey(db, stdout.trim()));
  expect(bot).toMatchObject({ displayName: "quiet", label: "agent-quiet" });
  expect(stderr).toContain(bot?.id);
  expect(stderr).toMatch(/can't be shown again/);
});

test("bot create with a name already taken exits 1 and says what to do", () => {
  run("bot", "create", "Twin");
  const { code, stdout, stderr } = run("bot", "create", "twin");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toMatch(
    /^trail: a bot named "Twin" already exists \(\S+\), and bot names match ignoring the case of A-Z: .*key create/,
  );
});

test("bot create with a label already taken exits 1", () => {
  run("bot", "create", "first holder", "--label", "agent-shared");
  const { code, stderr } = run(
    "bot",
    "create",
    "second holder",
    "--label",
    "agent-shared",
  );
  expect(code).toBe(1);
  expect(stderr).toMatch(/label "agent-shared" is already on bot/);
});

test.each([
  ["its actor id", (bot: { id: string; label: string | null }) => bot.id],
  ["its label", (bot: { id: string; label: string | null }) => bot.label ?? ""],
])("key create by %s mints a second working key for the bot", (how, ref) => {
  const label = `agent-${how.replace(/\W/g, "")}`;
  const first = createdKey(
    run("bot", "create", `keyed ${how}`, "--label", label).stdout,
  );
  const bot = withDb((db) => resolveKey(db, first));
  if (!bot) throw new Error("first key did not resolve");

  const { code, stdout } = run("key", "create", ref(bot));
  expect(code).toBe(0);
  const second = createdKey(stdout);
  expect(second).not.toBe(first);
  expect(withDb((db) => resolveKey(db, second))).toEqual(bot);
  expect(withDb((db) => resolveKey(db, first))).toEqual(bot);

  const quiet = run("key", "create", ref(bot), "--key-only");
  expect(quiet.stdout).toMatch(/^trail_[0-9a-f]{8}_[A-Za-z0-9_-]{43}\n$/);
  expect(withDb((db) => resolveKey(db, quiet.stdout.trim()))).toEqual(bot);
});

// the products and the project a scoped key can name; recon draws from both products
withDb((db) => {
  const { actor } = createBot(db, "product owner");
  const products = db
    .insert(product)
    .values(
      ["BTA", "ATL"].map((key) => ({ key, name: key, createdBy: actor.id })),
    )
    .returning()
    .all();
  const recon = db
    .insert(project)
    .values({
      slug: "recon",
      name: "Recon",
      leadId: actor.id,
      createdBy: actor.id,
    })
    .returning()
    .get();
  db.insert(projectProduct)
    .values(products.map((p) => ({ projectId: recon.id, productId: p.id })))
    .run();
});

const scopeOf = (key: string) =>
  withDb((db) => listKeys(db).find((k) => k.prefix === key.slice(6, 14)))
    ?.scope;

test("key create --products --actions mints a key with that scope, product keys in any case", () => {
  const first = createdKey(run("bot", "create", "scoped later").stdout);
  const bot = withDb((db) => resolveKey(db, first));
  if (!bot) throw new Error("first key did not resolve");
  const { code, stdout } = run(
    "key",
    "create",
    bot.id,
    "--products",
    "bta,ATL",
    "--actions",
    "read,issues,comments",
  );
  expect(code).toBe(0);
  const key = createdKey(stdout);
  expect(withDb((db) => resolveKey(db, key))).toEqual(bot);
  expect(scopeOf(key)).toEqual({
    products: ["ATL", "BTA"],
    projects: [],
    actions: ["read", "issues", "comments"],
  });
  expect(scopeOf(first)).toEqual({
    products: null,
    projects: null,
    actions: null,
  });
  expect(stdout).toMatch(
    /^actor {2}\S+\nkey {4}\S+\nscope {2}products ATL,BTA; actions read,issues,comments\n$/,
  );
});

test("bot create --products --key-only prints the key alone on stdout, its scope on stderr", () => {
  const { code, stdout, stderr } = run(
    "bot",
    "create",
    "alpha-scoped",
    "--products",
    "BTA",
    "--key-only",
  );
  expect(code).toBe(0);
  expect(stdout).toMatch(/^trail_[0-9a-f]{8}_[A-Za-z0-9_-]{43}\n$/);
  expect(withDb((db) => resolveKey(db, stdout.trim()))).toMatchObject({
    displayName: "alpha-scoped",
  });
  expect(scopeOf(stdout)).toEqual({
    products: ["BTA"],
    projects: [],
    actions: null,
  });
  expect(stderr).toMatch(
    /^actor {2}\S+\nscope {2}products BTA; all actions\n/m,
  );
});

test("bot create --actions alone limits only the actions", () => {
  const { code, stdout } = run("bot", "create", "reader", "--actions", "read");
  expect(code).toBe(0);
  expect(scopeOf(createdKey(stdout))).toEqual({
    products: null,
    projects: null,
    actions: ["read"],
  });
  expect(stdout).toMatch(/^scope {2}all products; actions read$/m);
});

test.each([
  [
    "an unknown product key",
    ["--products", "BTA,nope"],
    /^trail: no product NOPE: scope the key to products that exist, which are ATL, BTA\n/,
  ],
  [
    "an unknown action",
    ["--actions", "read,delete"],
    /^trail: unknown action "delete": /,
  ],
])(
  "a scope with %s is refused like other validation failures, minting nothing",
  (_, flags, reason) => {
    const keyCount = () => withDb((db) => listKeys(db).length);
    const actorCount = () =>
      withDb((db) => db.select().from(actor).all().length);
    const before = keyCount();
    const actors = actorCount();
    for (const argv of [
      ["bot", "create", "never scoped", ...flags],
      ["key", "create", "agent-quiet", ...flags],
    ]) {
      const { code, stdout, stderr } = run(...argv);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toMatch(reason);
      expect(stderr).toMatch(/\nUsage:/);
    }
    expect(keyCount()).toBe(before);
    // a refused mint leaves no orphaned bot row, which a key count can't see
    expect(actorCount()).toBe(actors);
    expect(run("key", "create", "never scoped").code).toBe(1);
  },
);

test.each([
  ["--products ''", ["--products", ""]],
  ["--projects with a blank entry", ["--projects=recon,"]],
  ["--actions ,", ["--actions", ","]],
  ["--actions with a blank entry", ["--actions=read,,issues"]],
])("%s is a usage error before the database is opened", (_, flags) => {
  const missing = join(dir, "missing", "trail.db");
  const { code, stdout, stderr } = runAt(missing, [
    "key",
    "create",
    "agent-quiet",
    ...flags,
  ]);
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toMatch(
    /^trail: --(products|projects|actions) takes a comma-separated list/,
  );
});

test("bot create --projects alone mints a project-only key and prints its scope", () => {
  const { code, stdout, stderr } = run(
    "bot",
    "create",
    "alpha-recon",
    "--projects",
    "recon",
  );
  expect(stderr).not.toMatch(/deprecated/);
  expect(code).toBe(0);
  const key = createdKey(stdout);
  expect(scopeOf(key)).toEqual({
    products: [],
    projects: ["recon"],
    actions: null,
  });
  expect(stdout).toMatch(/\nscope {2}projects recon; all actions\n$/);
});

test("key create --products --projects --actions mints a key reaching both, printed on one scope line", () => {
  const { code, stdout } = run(
    "key",
    "create",
    "agent-quiet",
    "--products",
    "ATL",
    "--projects",
    "recon",
    "--actions",
    "read,comments",
  );
  expect(code).toBe(0);
  expect(scopeOf(createdKey(stdout))).toEqual({
    products: ["ATL"],
    projects: ["recon"],
    actions: ["read", "comments"],
  });
  expect(stdout).toMatch(
    /\nscope {2}products ATL; projects recon; actions read,comments\n$/,
  );
});

test.each([
  ["key create", ["key", "create", "agent-quiet"]],
  ["bot create", ["bot", "create", "beta-recon"]],
])(
  "%s --projects with a product key is a usage error naming --products, minting nothing",
  (_, argv) => {
    const before = withDb((db) => listKeys(db).length);
    for (const value of ["recon,ATL", "atl"]) {
      const { code, stdout, stderr } = run(...argv, "--projects", value);
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(stderr.split("\n")[0]).toBe(
        "trail: --projects takes project slugs; ATL is a product key: pass it with --products",
      );
    }
    expect(withDb((db) => listKeys(db).length)).toBe(before);
  },
);

test("--projects with an unknown slug is refused like an unknown product, listing the slugs that exist", () => {
  const { code, stdout, stderr } = run(
    "key",
    "create",
    "agent-quiet",
    "--projects",
    "recon,nope",
  );
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr.split("\n")[0]).toBe(
    "trail: no project nope: scope the key to projects that exist, by slug, which are recon",
  );
});

test("products owners prints each product's current owner, one line per product, writing nothing", () => {
  withDb((db) => {
    const alpha = createBot(db, "alpha").actor;
    db.update(product)
      .set({ ownerId: alpha.id })
      .where(eq(product.key, "BTA"))
      .run();
  });
  const productRows = () => withDb((db) => db.select().from(product).all());
  const before = productRows();
  const { code, stdout, stderr } = run("products", "owners");
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toBe("product  owner\nATL      none\nBTA      alpha\n");
  expect(productRows()).toEqual(before);
});

test("products set-owner sets the owner by bot name, label or id, and prints from and to", () => {
  const owner = withDb(
    (db) => createBot(db, "Atlas", { label: "agent-atlas" }).actor,
  );
  const first = run("products", "set-owner", "atl", "agent-atlas");
  expect(first.code).toBe(0);
  expect(first.stdout).toBe(
    `product  ATL\nfrom     -\nto       Atlas (${owner.id})\n`,
  );
  const ownerOf = () =>
    withDb(
      (db) =>
        db.$client
          .prepare<[], string | null>(
            "select owner_id from product where key = 'ATL'",
          )
          .pluck()
          .get() ?? null,
    );
  expect(ownerOf()).toBe(owner.id);
  const again = run("products", "set-owner", "ATL", "product owner");
  expect(again.code).toBe(0);
  expect(again.stdout).toMatch(/^from {5}Atlas \(\S+\)\nto {7}product owner /m);
  expect(ownerOf()).not.toBe(owner.id);
});

test("products set-owner refuses a person and an unknown product or bot with exit 1, changing nothing", () => {
  const person = withDb((db) => createHuman(db, { displayName: "Pat" }));
  for (const argv of [
    ["products", "set-owner", "BTA", person.id],
    ["products", "set-owner", "BTA", "nobody-at-all"],
    ["products", "set-owner", "NOPE", "alpha"],
  ]) {
    const { code, stdout, stderr } = run(...argv);
    expect(code, argv.join(" ")).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^trail: /);
  }
  expect(run("products", "set-owner", "NOPE", "alpha").stderr).toBe(
    "trail: no product NOPE: `trail products owners` lists every product's key\n",
  );
});

test("products set-repo sets a GitHub URL, a trailing .git dropped; anything else is exit 2", () => {
  const set = run(
    "products",
    "set-repo",
    "bta",
    "https://github.com/acme/bta.git",
  );
  expect(set.code).toBe(0);
  expect(set.stdout).toBe(
    "product  BTA\nfrom     -\nto       https://github.com/acme/bta\n",
  );
  const bad = run("products", "set-repo", "BTA", "https://gitlab.com/acme/bta");
  expect(bad.code).toBe(2);
  expect(bad.stderr).toMatch(/^trail: repoUrl must be a GitHub repository/);
  const missing = run("products", "set-repo", "BTA");
  expect(missing.code).toBe(2);
  expect(missing.stderr).toMatch(/^trail: missing <url>/);
});

test("key create for no such bot exits 1", () => {
  const { code, stdout, stderr } = run("key", "create", "agent-nobody");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toMatch(/^trail: no bot with id or label agent-nobody/);
});

test("key list shows each key's prefix, bot, label, times, products, projects and actions, never the key or its hash", () => {
  const key = createdKey(
    run("bot", "create", "listed", "--label", "agent-listed").stdout,
  );
  const prefix = key.slice(6, 14);
  run("key", "revoke", prefix);
  const { code, stdout } = run("key", "list");
  expect(code).toBe(0);
  const hash = withDb(
    (db) =>
      db.$client
        .prepare<[string], string>("select hash from api_key where prefix = ?")
        .pluck()
        .get(prefix) as string,
  );
  expect(stdout).not.toContain(key.slice(15));
  expect(stdout).not.toContain(hash);
  const header = stdout.split("\n")[0];
  expect(header).toMatch(
    /^prefix\s+actor\s+name\s+label\s+created\s+revoked\s+products\s+projects\s+actions$/,
  );
  const line = stdout.split("\n").find((l) => l.startsWith(prefix));
  expect(line).toMatch(
    new RegExp(
      `^${prefix}\\s+\\S+\\s+listed\\s+agent-listed\\s+\\d{4}-\\d\\d-\\d\\dT\\S+Z\\s+\\d{4}-\\d\\d-\\d\\dT\\S+Z\\s+all products\\s+-\\s+all actions$`,
    ),
  );
});

test.each([
  [
    "products only",
    ["--products", "atl,bta", "--actions", "comments,read"],
    /\s+-\s+ATL,BTA\s+-\s+read,comments$/,
  ],
  ["projects only", ["--projects", "recon"], /\s+-\s+-\s+recon\s+all actions$/],
  [
    "products and projects",
    ["--products", "BTA", "--projects", "recon"],
    /\s+-\s+BTA\s+recon\s+all actions$/,
  ],
])(
  "key list shows a key scoped to %s in its products and projects columns",
  (scope, flags, cells) => {
    const key = run(
      "bot",
      "create",
      `listed ${scope}`,
      ...flags,
      "--key-only",
    ).stdout;
    const line = run("key", "list")
      .stdout.split("\n")
      .find((l) => l.startsWith(key.slice(6, 14)));
    // revoked `-`, then the scope cells
    expect(line).toMatch(new RegExp(`\\dZ${cells.source}`));
  },
);

const mint = (...flags: string[]) =>
  run("key", "create", "agent-quiet", ...flags, "--key-only").stdout.trim();

test("key scope adds a project and products, the flags repeated and combined, and prints the new scope", () => {
  const key = mint("--products", "BTA");
  const { code, stdout, stderr } = run(
    "key",
    "scope",
    key.slice(6, 14),
    "--add-project",
    "recon",
    "--add-product",
    "atl",
    "--add-product",
    "BTA",
  );
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout).toBe("scope  products ATL,BTA; projects recon; all actions\n");
  expect(scopeOf(key)).toEqual({
    products: ["ATL", "BTA"],
    projects: ["recon"],
    actions: null,
  });
});

test("key scope by the full key removes products and projects, leaving a project-only or product-only key", () => {
  const key = mint(
    "--products",
    "ATL,BTA",
    "--projects",
    "recon",
    "--actions",
    "read",
  );
  const projectOnly = run(
    "key",
    "scope",
    key,
    "--remove-product",
    "ATL",
    "--remove-product",
    "bta",
  );
  expect(projectOnly.code).toBe(0);
  expect(projectOnly.stdout).toBe("scope  projects recon; actions read\n");
  const productOnly = run(
    "key",
    "scope",
    key,
    "--remove-project",
    "recon",
    "--add-product",
    "BTA",
  );
  expect(productOnly.code).toBe(0);
  expect(productOnly.stdout).toBe("scope  products BTA; actions read\n");
  expect(scopeOf(key)).toEqual({
    products: ["BTA"],
    projects: [],
    actions: ["read"],
  });
});

test("key scope that changes nothing prints the scope and a one-line note on stderr", () => {
  const key = mint("--projects", "recon");
  const { code, stdout, stderr } = run(
    "key",
    "scope",
    key.slice(6, 14),
    "--add-project",
    "recon",
    "--remove-product",
    "ATL",
  );
  expect(code).toBe(0);
  expect(stdout).toBe("scope  projects recon; all actions\n");
  expect(stderr).toBe(
    "trail: nothing changed: the key already reaches what was added and not what was removed\n",
  );
});

test.each([
  [
    "taking the last project off a restricted key",
    () => mint("--projects", "recon"),
    ["--remove-project", "recon"],
    (prefix: string) =>
      `trail: that edit leaves the key with no product and no project, and a key with neither reaches everything: add a product or project in the same edit, or revoke the key with \`trail key revoke ${prefix}\`\n`,
  ],
  [
    "adding to an unrestricted key",
    () => mint(),
    ["--add-project", "recon"],
    () =>
      "trail: this key is unrestricted and already reaches every product and project, so adding to it changes nothing: mint a key limited to what it should reach with `trail key create`, and revoke this one\n",
  ],
])(
  "key scope %s exits 1 with the reason, changing nothing",
  (_, keyOf, flags, reason) => {
    const key = keyOf();
    const prefix = key.slice(6, 14);
    const before = scopeOf(key);
    const { code, stdout, stderr } = run("key", "scope", prefix, ...flags);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(reason(prefix));
    expect(scopeOf(key)).toEqual(before);
  },
);

test("key scope of an unknown prefix exits 1 pointing at key list", () => {
  const { code, stdout, stderr } = run(
    "key",
    "scope",
    "00000000",
    "--add-project",
    "recon",
  );
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe(
    "trail: no live key with prefix 00000000: `trail key list` shows each key's prefix\n",
  );
});

test.each([
  [
    "a product key to --add-project",
    ["--add-project", "ATL"],
    "trail: --add-project takes project slugs; ATL is a product key: pass it with --add-product",
  ],
  [
    "an unknown slug to --add-project",
    ["--add-project", "nope"],
    "trail: no project nope: scope the key to projects that exist, by slug, which are recon",
  ],
])(
  "key scope with %s is a usage error, changing nothing",
  (_, flags, reason) => {
    const key = mint("--products", "BTA");
    const { code, stdout, stderr } = run(
      "key",
      "scope",
      key.slice(6, 14),
      ...flags,
    );
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr.split("\n")[0]).toBe(reason);
    expect(scopeOf(key)?.projects).toEqual([]);
  },
);

test("key revoke of an unknown prefix exits 1 with the reason on stderr", () => {
  const { code, stdout, stderr } = run("key", "revoke", "00000000");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe("trail: no key with prefix 00000000\n");
});

test.each([
  ["bot create", ["bot", "create", "nowhere"]],
  ["key create", ["key", "create", "agent-nowhere"]],
  ["key list", ["key", "list"]],
  ["key revoke", ["key", "revoke", "00000000"]],
])(
  "%s with no file at DATABASE_PATH exits 1 naming the resolved path, and creates nothing",
  (_, argv) => {
    const missing = join(dir, "missing", "trail.db");
    const { code, stdout, stderr } = runAt(
      relative(process.cwd(), missing),
      argv,
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      `trail: no database at ${missing}: set DATABASE_PATH to the server's database file (/data/trail.db on Fly) and retry; the server creates the file on its first start\n`,
    );
    expect(existsSync(join(dir, "missing"))).toBe(false);
  },
);

test.each([
  ["no command", []],
  ["an unknown command", ["bot", "delete", "x"]],
  ["bot create without a name", ["bot", "create"]],
  ["bot create with a blank name", ["bot", "create", "  "]],
  ["bot create with two names", ["bot", "create", "a", "b"]],
  ["key revoke without a prefix", ["key", "revoke"]],
  ["key revoke of a malformed prefix", ["key", "revoke", "trail_xyz"]],
  ["an unknown option", ["bot", "create", "a", "--bogus"]],
  ["key create without a bot", ["key", "create"]],
  ["--label on a command without one", ["key", "list", "--label", "x"]],
  ["--key-only on key revoke", ["key", "revoke", "00000000", "--key-only"]],
  ["key list with an argument", ["key", "list", "x"]],
  ["bot rename without a bot", ["bot", "rename"]],
  ["bot rename without a name", ["bot", "rename", "someone"]],
  ["bot title without a bot", ["bot", "title"]],
  ["bot title without a title or --clear", ["bot", "title", "someone"]],
  [
    "bot title --clear with a title",
    ["bot", "title", "someone", "x", "--clear"],
  ],
  ["--clear on another command", ["bot", "rename", "a", "b", "--clear"]],
  ["key scope without a change", ["key", "scope", "00000000"]],
  [
    "key scope with a blank slug",
    ["key", "scope", "00000000", "--add-project="],
  ],
  ["key scope without a prefix", ["key", "scope", "--add-project", "recon"]],
  [
    "key scope of a malformed prefix",
    ["key", "scope", "nope", "--add-project", "recon"],
  ],
  [
    "--add-project on another command",
    ["key", "create", "agent-quiet", "--add-project", "recon"],
  ],
])("%s is a usage error: exit 2, usage on stderr", (_, argv) => {
  const { code, stdout, stderr } = run(...argv);
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toMatch(/^trail: .+\nUsage:/);
});

test.each([
  ["id", (bot: { id: string }) => bot.id],
  ["label", (bot: { label: string | null }) => bot.label as string],
  [
    "current name",
    (bot: { displayName: string }) => bot.displayName.toUpperCase(),
  ],
])(
  "bot rename by %s renames the bot and its key still resolves to it",
  (form, ref) => {
    const tag = form.replace(" ", "-");
    const created = createdKey(
      run("bot", "create", `Before ${form}`, "--label", `ren-${tag}`).stdout,
    );
    const before = withDb((db) => resolveKey(db, created));
    if (before?.kind !== "bot") throw new Error("bot not created");
    const { code, stdout, stderr } = run(
      "bot",
      "rename",
      ref(before),
      `After ${form}`,
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(
      `actor  ${before.id}\nfrom   Before ${form}\nto     After ${form}\n`,
    );
    expect(stdout).not.toContain("trail_");
    expect(withDb((db) => resolveKey(db, created))).toEqual({
      ...before,
      displayName: `After ${form}`,
    });
  },
);

test("bot rename accepts its own name in another case and an unquoted name", () => {
  const { stdout } = run("bot", "create", "Casey Bot");
  const id = /^actor\s+(\S+)$/m.exec(stdout)?.[1] as string;
  const key = createdKey(stdout);
  expect(run("bot", "rename", id, "casey bot").code).toBe(0);
  expect(withDb((db) => resolveKey(db, key))?.displayName).toBe("casey bot");
  expect(run("bot", "rename", id, "  Casey", "Two  ").code).toBe(0);
  expect(withDb((db) => resolveKey(db, key))?.displayName).toBe("Casey Two");
});

test("bot rename to its own exact name exits 0 and leaves the name", () => {
  const key = createdKey(run("bot", "create", "Same Name").stdout);
  const id = withDb((db) => resolveKey(db, key))?.id as string;
  const { code, stdout, stderr } = run("bot", "rename", id, "Same Name");
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout).toBe(`actor  ${id}\nfrom   Same Name\nto     Same Name\n`);
  expect(withDb((db) => resolveKey(db, key))?.displayName).toBe("Same Name");
});

test("bot rename to another bot's name, ignoring case, exits 1 and changes nothing", () => {
  run("bot", "create", "Taken Name");
  const key = createdKey(run("bot", "create", "Free Name").stdout);
  const { code, stdout, stderr } = run(
    "bot",
    "rename",
    "Free Name",
    "TAKEN name",
  );
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toMatch(/^trail: a bot named "Taken Name" already exists/);
  expect(withDb((db) => resolveKey(db, key))?.displayName).toBe("Free Name");
});

test("bot rename by id wins over another bot named that id", () => {
  const a = createdKey(run("bot", "create", "Shadowed A").stdout);
  const aId = withDb((db) => resolveKey(db, a))?.id as string;
  const b = createdKey(run("bot", "create", aId).stdout);
  const { code, stderr } = run("bot", "rename", aId, "Renamed A");
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(withDb((db) => resolveKey(db, a))?.displayName).toBe("Renamed A");
  expect(withDb((db) => resolveKey(db, b))?.displayName).toBe(aId);
});

test("bot rename of a ref matching two bots by label and name exits 1 and renames neither", () => {
  const labelled = createdKey(
    run("bot", "create", "Ambiguous L", "--label", "amb-ref").stdout,
  );
  const named = createdKey(run("bot", "create", "amb-ref").stdout);
  const { code, stdout, stderr } = run("bot", "rename", "amb-ref", "Either");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toMatch(/^trail: "amb-ref" matches more than one bot/);
  expect(withDb((db) => resolveKey(db, labelled))?.displayName).toBe(
    "Ambiguous L",
  );
  expect(withDb((db) => resolveKey(db, named))?.displayName).toBe("amb-ref");
});

test("bot rename of an unknown bot exits 1", () => {
  const { code, stdout, stderr } = run("bot", "rename", "agent-nobody", "X");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toMatch(/^trail: no bot with id, label or name agent-nobody/);
});

test("bot rename refuses a person", () => {
  const person = withDb((db) => createHuman(db, { displayName: "Pat Person" }));
  const { code, stderr } = run("bot", "rename", person.id, "Patty");
  expect(code).toBe(1);
  expect(stderr).toMatch(/is a person, not a bot/);
  expect(
    withDb((db) => db.select().from(actor).all()).find(
      (a) => a.id === person.id,
    )?.displayName,
  ).toBe("Pat Person");
  // a person's name is not a way to reach them
  const byName = run("bot", "rename", "Pat Person", "Patty");
  expect(byName.code).toBe(1);
  expect(byName.stderr).toMatch(/no bot with id, label or name/);
});

test("bot rename by a person's id refuses the person even when a bot is named that id", () => {
  const person = withDb((db) => createHuman(db, { displayName: "Sam Person" }));
  const bot = createdKey(run("bot", "create", person.id).stdout);
  const { code, stdout, stderr } = run("bot", "rename", person.id, "Sammy");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe(
    `trail: ${person.id} is a person, not a bot: people's names come from their sign-in\n`,
  );
  expect(withDb((db) => resolveKey(db, bot))?.displayName).toBe(person.id);
  expect(
    withDb((db) => db.select().from(actor).all()).find(
      (a) => a.id === person.id,
    )?.displayName,
  ).toBe("Sam Person");
});

test("bot rename to a blank name exits 2 and leaves the bot's name", () => {
  const key = createdKey(run("bot", "create", "Blank Target").stdout);
  const { code, stdout, stderr } = run("bot", "rename", "Blank Target", "   ");
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toMatch(/^trail: .*display name must not be empty/);
  expect(withDb((db) => resolveKey(db, key))?.displayName).toBe("Blank Target");
});

const titleOf = (key: string) => withDb((db) => resolveKey(db, key))?.title;

test("bot title sets a bot's title by label, trimmed, then --clear removes it", () => {
  const key = createdKey(
    run("bot", "create", "Titled Bot", "--label", "titled-agent").stdout,
  );
  const id = withDb((db) => resolveKey(db, key))?.id as string;
  const set = run("bot", "title", "titled-agent", "  Release manager ");
  expect(set.stderr).toBe("");
  expect(set.code).toBe(0);
  expect(set.stdout).toBe(`actor  ${id}\nfrom   -\nto     Release manager\n`);
  expect(titleOf(key)).toBe("Release manager");

  const cleared = run("bot", "title", "titled-agent", "--clear");
  expect(cleared.code).toBe(0);
  expect(cleared.stdout).toBe(
    `actor  ${id}\nfrom   Release manager\nto     -\n`,
  );
  expect(titleOf(key)).toBeNull();
});

test("bot title by id or name, unquoted, keeps 40 characters and refuses 41 or blank with exit 2", () => {
  const key = createdKey(run("bot", "create", "Long Titled").stdout);
  const id = withDb((db) => resolveKey(db, key))?.id as string;
  expect(run("bot", "title", id, "On", "call").code).toBe(0);
  expect(titleOf(key)).toBe("On call");
  const forty = "t".repeat(40);
  expect(run("bot", "title", "LONG TITLED", forty).code).toBe(0);
  expect(titleOf(key)).toBe(forty);
  for (const title of ["u".repeat(41), "  \t"]) {
    const { code, stdout, stderr } = run("bot", "title", id, title);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^trail: title must /);
  }
  expect(titleOf(key)).toBe(forty);
});

test("bot title refuses a person, an unknown bot and an ambiguous ref with exit 1, changing nothing", () => {
  const person = withDb((db) =>
    createHuman(db, { displayName: "Titled Person" }),
  );
  const personRun = run("bot", "title", person.id, "Boss");
  expect(personRun.code).toBe(1);
  expect(personRun.stderr).toBe(
    `trail: ${person.id} is a person, not a bot: only bots have titles\n`,
  );
  const unknown = run("bot", "title", "agent-nobody", "X");
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toMatch(
    /^trail: no bot with id, label or name agent-nobody/,
  );
  const labelled = createdKey(
    run("bot", "create", "Amb Title L", "--label", "amb-title").stdout,
  );
  const named = createdKey(run("bot", "create", "amb-title").stdout);
  const ambiguous = run("bot", "title", "amb-title", "Either");
  expect(ambiguous.code).toBe(1);
  expect(ambiguous.stdout).toBe("");
  expect(ambiguous.stderr).toMatch(
    /^trail: "amb-title" matches more than one bot/,
  );
  expect(titleOf(labelled)).toBeNull();
  expect(titleOf(named)).toBeNull();
  expect(
    withDb((db) => db.select().from(actor).all()).find(
      (a) => a.id === person.id,
    )?.title,
  ).toBeNull();
});

test("--help prints usage on stdout and exits 0, naming key scope and --projects", () => {
  const { code, stdout, stderr } = run("--help");
  expect(code).toBe(0);
  expect(stdout).toMatch(/^Usage:/);
  expect(stdout).toMatch(/^ {2}trail key scope <prefix> /m);
  expect(stdout).toMatch(/^ {2}--projects <slugs> /m);
  expect(stdout).not.toMatch(/old name/);
  expect(stderr).toBe("");
});

test("the script wires the exit status and streams through to the process", () => {
  const cli = new URL("./cli.ts", import.meta.url).pathname;
  const spawn = (...argv: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", cli, ...argv], {
      env: { ...process.env, DATABASE_PATH },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const created = spawn("bot", "create", "spawned");
  expect(created.status).toBe(0);
  expect(
    withDb((db) => resolveKey(db, createdKey(created.stdout))),
  ).toMatchObject({
    displayName: "spawned",
  });
  const unknown = spawn("key", "revoke", "00000000");
  expect([unknown.status, unknown.stdout]).toEqual([1, ""]);
  expect(spawn().status).toBe(2);
  // four cold tsx starts, serial, while other files run in parallel
}, 30_000);
