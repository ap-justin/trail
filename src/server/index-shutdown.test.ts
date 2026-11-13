import { type ChildProcess, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { readEventStream, setupTestApp, testAuthConfig } from "./test-app.js";

const { db, signIn, owner } = setupTestApp();
const dir = mkdtempSync(join(tmpdir(), "trail-index-shutdown-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const entry = new URL("./index.ts", import.meta.url).pathname;

/** The real entrypoint on a copy of the test app's database, which holds the owner's session. */
function spawnEntry(databasePath: string) {
  return spawn(process.execPath, ["--import", "tsx", entry], {
    env: {
      PATH: process.env.PATH,
      DATABASE_PATH: databasePath,
      PORT: "0",
      TRAIL_OWNER_GITHUB: testAuthConfig.TRAIL_OWNER_GITHUB,
      BETTER_AUTH_SECRET: testAuthConfig.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: testAuthConfig.BETTER_AUTH_URL,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const listening = (child: ChildProcess) =>
  new Promise<number>((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const port = output.match(/trail listening on :(\d+)/)?.[1];
      if (port) resolve(Number(port));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("close", () => reject(new Error(`exited early: ${output}`)));
  });

const exited = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
  );

test("SIGTERM ends an open event stream, closes the database and dies by the signal", async () => {
  const cookie = await signIn(owner);
  // folds the session into the main file, so the copy is the whole database
  db.$client.pragma("wal_checkpoint(TRUNCATE)");
  const databasePath = join(dir, "trail.db");
  copyFileSync(db.$client.name, databasePath);

  const child = spawnEntry(databasePath);
  const done = exited(child);
  let stream: ReturnType<typeof readEventStream> | undefined;
  try {
    const port = await listening(child);
    const res = await fetch(`http://127.0.0.1:${port}/api/web/events`, {
      headers: { cookie },
      signal: AbortSignal.timeout(20_000),
    });
    expect(res.status).toBe(200);
    stream = readEventStream(res);
    expect(await stream.next()).toEqual({ comment: "connected" });
    // WAL mode keeps -wal and -shm beside an open database
    expect(existsSync(`${databasePath}-wal`)).toBe(true);

    const started = Date.now();
    child.kill("SIGTERM");
    // the stream ends on the drain, well inside the 4 s deadline that would cut it
    // a photo refresh may announce itself first, so read on to the end, a bounded few events
    let last: unknown = "open";
    for (let i = 0; i < 5 && last !== null; i++) last = await stream.next();
    expect(last).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_500);

    expect(await done).toEqual({ code: null, signal: "SIGTERM" });
    // closing the last connection removes the WAL files; a process that skipped the close leaves them
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
  } finally {
    await stream?.cancel().catch(() => {});
    child.kill("SIGKILL");
  }
}, 40_000);
