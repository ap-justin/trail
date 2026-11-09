import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { migrate, openDatabase } from "./db/client.js";
import { resolveKey } from "./service/keys.js";

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
  run("bot", "create", "twin");
  const { code, stdout, stderr } = run("bot", "create", "twin");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toMatch(
    /^trail: a bot named "twin" already exists \(\S+\), and bot names match ignoring the case of A-Z: .*key create/,
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

test("key create for no such bot exits 1", () => {
  const { code, stdout, stderr } = run("key", "create", "agent-nobody");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toMatch(/^trail: no bot with id or label agent-nobody/);
});

test("key list shows each key's prefix, bot, label and times, never the key or its hash", () => {
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
  expect(header).toMatch(/^prefix\s+actor\s+name\s+label\s+created\s+revoked$/);
  const line = stdout.split("\n").find((l) => l.startsWith(prefix));
  expect(line).toMatch(
    new RegExp(
      `^${prefix}\\s+\\S+\\s+listed\\s+agent-listed\\s+\\d{4}-\\d\\d-\\d\\dT\\S+Z\\s+\\d{4}-\\d\\d-\\d\\dT\\S+Z$`,
    ),
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
])("%s is a usage error: exit 2, usage on stderr", (_, argv) => {
  const { code, stdout, stderr } = run(...argv);
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toMatch(/^trail: .+\nUsage:/);
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
