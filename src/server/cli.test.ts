import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { openDatabase } from "./db/client.js";
import { resolveKey } from "./service/keys.js";

const dir = mkdtempSync(join(tmpdir(), "trail-cli-"));
const DATABASE_PATH = join(dir, "trail.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runCli(argv, {
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
    env: { DATABASE_PATH },
  });
  return { code, stdout, stderr };
}

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
])("key revoke by %s stops the key resolving", (_, form) => {
  const key = createdKey(run("bot", "create", "revoked").stdout);
  const { code, stdout } = run("key", "revoke", form(key));
  expect(code).toBe(0);
  expect(stdout).toContain(`revoked trail_${key.slice(6, 14)}`);
  expect(withDb((db) => resolveKey(db, key))).toBeNull();
});

test("key revoke of an unknown prefix exits 1 with the reason on stderr", () => {
  const { code, stdout, stderr } = run("key", "revoke", "00000000");
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBe("trail: no key with prefix 00000000\n");
});

test.each([
  ["no command", []],
  ["an unknown command", ["bot", "delete", "x"]],
  ["bot create without a name", ["bot", "create"]],
  ["bot create with a blank name", ["bot", "create", "  "]],
  ["bot create with two names", ["bot", "create", "a", "b"]],
  ["key revoke without a prefix", ["key", "revoke"]],
  ["key revoke of a malformed prefix", ["key", "revoke", "trail_xyz"]],
  ["an unknown option", ["bot", "create", "a", "--bogus"]],
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
});
