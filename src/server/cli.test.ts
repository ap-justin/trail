import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { migrate, openDatabase } from "./db/client.js";
import { actor, project } from "./db/schema.js";
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

// the projects a scoped key can name
withDb((db) => {
  const { actor } = createBot(db, "project owner");
  db.insert(project)
    .values(
      ["BGP", "ATL"].map((key) => ({ key, name: key, createdBy: actor.id })),
    )
    .run();
});

const scopeOf = (key: string) =>
  withDb((db) => listKeys(db).find((k) => k.prefix === key.slice(6, 14)))
    ?.scope;

test("key create --projects --actions mints a key with that scope, project keys in any case", () => {
  const first = createdKey(run("bot", "create", "scoped later").stdout);
  const bot = withDb((db) => resolveKey(db, first));
  if (!bot) throw new Error("first key did not resolve");
  const { code, stdout } = run(
    "key",
    "create",
    bot.id,
    "--projects",
    "bgp,ATL",
    "--actions",
    "read,issues,comments",
  );
  expect(code).toBe(0);
  const key = createdKey(stdout);
  expect(withDb((db) => resolveKey(db, key))).toEqual(bot);
  expect(scopeOf(key)).toEqual({
    projects: ["ATL", "BGP"],
    actions: ["read", "issues", "comments"],
  });
  expect(scopeOf(first)).toEqual({ projects: null, actions: null });
  expect(stdout).toMatch(
    /^actor {2}\S+\nkey {4}\S+\nscope {2}projects ATL,BGP; actions read,issues,comments\n$/,
  );
});

test("bot create --projects --key-only prints the key alone on stdout, its scope on stderr", () => {
  const { code, stdout, stderr } = run(
    "bot",
    "create",
    "bg-ivy",
    "--projects",
    "BGP",
    "--key-only",
  );
  expect(code).toBe(0);
  expect(stdout).toMatch(/^trail_[0-9a-f]{8}_[A-Za-z0-9_-]{43}\n$/);
  expect(withDb((db) => resolveKey(db, stdout.trim()))).toMatchObject({
    displayName: "bg-ivy",
  });
  expect(scopeOf(stdout)).toEqual({ projects: ["BGP"], actions: null });
  expect(stderr).toMatch(
    /^actor {2}\S+\nscope {2}projects BGP; all actions\n/m,
  );
});

test("bot create --actions alone limits only the actions", () => {
  const { code, stdout } = run("bot", "create", "reader", "--actions", "read");
  expect(code).toBe(0);
  expect(scopeOf(createdKey(stdout))).toEqual({
    projects: null,
    actions: ["read"],
  });
  expect(stdout).toMatch(/^scope {2}all projects; actions read$/m);
});

test.each([
  [
    "an unknown project key",
    ["--projects", "BGP,nope"],
    /^trail: no project with key NOPE: /,
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
  ["--projects ''", ["--projects", ""]],
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
    /^trail: --(projects|actions) takes a comma-separated list/,
  );
});

test("key create for no such bot exits 1", () => {
  const { code, stdout, stderr } = run("key", "create", "agent-nobody");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toMatch(/^trail: no bot with id or label agent-nobody/);
});

test("key list shows each key's prefix, bot, label, times and scope, never the key or its hash", () => {
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
    /^prefix\s+actor\s+name\s+label\s+created\s+revoked\s+projects\s+actions$/,
  );
  const line = stdout.split("\n").find((l) => l.startsWith(prefix));
  expect(line).toMatch(
    new RegExp(
      `^${prefix}\\s+\\S+\\s+listed\\s+agent-listed\\s+\\d{4}-\\d\\d-\\d\\dT\\S+Z\\s+\\d{4}-\\d\\d-\\d\\dT\\S+Z\\s+all projects\\s+all actions$`,
    ),
  );

  const scoped = run(
    "bot",
    "create",
    "listed scoped",
    "--projects",
    "atl,bgp",
    "--actions",
    "comments,read",
    "--key-only",
  ).stdout;
  const scopedLine = run("key", "list")
    .stdout.split("\n")
    .find((l) => l.startsWith(scoped.slice(6, 14)));
  expect(scopedLine).toMatch(
    /\s+-\s+\d{4}-\d\d-\d\dT\S+Z\s+-\s+ATL,BGP\s+read,comments$/,
  );
});

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

test("--help prints usage on stdout and exits 0", () => {
  const { code, stdout, stderr } = run("--help");
  expect(code).toBe(0);
  expect(stdout).toMatch(/^Usage:/);
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
