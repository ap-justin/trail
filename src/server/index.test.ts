import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "trail-index-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const entry = new URL("./index.ts", import.meta.url).pathname;

const valid = {
  TRAIL_OWNER_GITHUB: "boot-owner",
  BETTER_AUTH_SECRET: "boot-secret-that-is-at-least-32-characters",
};

/** The real entrypoint under a bare environment of exactly `env`, stopped once it listens or exits. */
function boot(env: Record<string, string>, name: string) {
  const databasePath = join(dir, `${name}.db`);
  return new Promise<{
    status: number | null;
    output: string;
    listening: boolean;
    databasePath: string;
  }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      // no inherited TRAIL_* or BETTER_AUTH_*: the caller's shell must not satisfy the config
      env: {
        PATH: process.env.PATH,
        DATABASE_PATH: databasePath,
        PORT: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let listening = false;
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (!listening && output.includes("trail listening on")) {
        listening = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (status) =>
      resolve({ status, output, listening, databasePath }),
    );
  });
}

test("the entrypoint boots and listens with both required variables", async () => {
  const run = await boot(valid, "valid");
  expect(run.listening).toBe(true);
}, 30_000);

test.each([
  ["TRAIL_OWNER_GITHUB", "missing", { TRAIL_OWNER_GITHUB: undefined }],
  ["TRAIL_OWNER_GITHUB", "empty", { TRAIL_OWNER_GITHUB: "" }],
  ["BETTER_AUTH_SECRET", "missing", { BETTER_AUTH_SECRET: undefined }],
  ["BETTER_AUTH_SECRET", "empty", { BETTER_AUTH_SECRET: "" }],
  [
    "BETTER_AUTH_SECRET",
    "31 characters",
    { BETTER_AUTH_SECRET: "x".repeat(31) },
  ],
] as const)(
  "the entrypoint exits non-zero naming %s when it is %s, before touching the database",
  async (variable, name, change) => {
    const env: Record<string, string> = { ...valid };
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    const run = await boot(env, `${variable}-${name}`.replace(/\W/g, "_"));
    expect(run.listening).toBe(false);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain(variable);
    expect(existsSync(run.databasePath)).toBe(false);
  },
  30_000,
);
