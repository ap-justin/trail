import { type ChildProcess, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { openDatabase } from "./db/client.js";
import { actor, issueEndMail } from "./db/schema.js";
import { createBot, setBotHandler } from "./service/keys.js";
import { readEventStream, setupTestApp, testAuthConfig } from "./test-app.js";

const { db, signIn, owner, bot, request, inviteEmail, signInWithEmail } =
  setupTestApp();
const dir = mkdtempSync(join(tmpdir(), "trail-index-shutdown-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const entry = new URL("./index.ts", import.meta.url).pathname;

/** The real entrypoint on a copy of the test app's database, which holds the owner's session. */
function spawnEntry(
  databasePath: string,
  extra: { env?: NodeJS.ProcessEnv; imports?: string[] } = {},
) {
  const imports = ["tsx", ...(extra.imports ?? [])];
  return spawn(
    process.execPath,
    [...imports.flatMap((i) => ["--import", i]), entry],
    {
      env: {
        ...extra.env,
        PATH: process.env.PATH,
        DATABASE_PATH: databasePath,
        PORT: "0",
        TRAIL_OWNER_GITHUB: testAuthConfig.TRAIL_OWNER_GITHUB,
        BETTER_AUTH_SECRET: testAuthConfig.BETTER_AUTH_SECRET,
        BETTER_AUTH_URL: testAuthConfig.BETTER_AUTH_URL,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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

/** A database copy holding one issue ended for a handled person, its email still pending. */
async function pendingCopy(tag: string) {
  const person = `${tag}.person@example.com`;
  const productKey = tag.toUpperCase();
  inviteEmail(person);
  await signInWithEmail(person);
  const handled = createBot(db, `${tag} handled`);
  setBotHandler(db, handled.actor.id, person);
  const send = async (
    method: string,
    path: string,
    key: string,
    json: object,
  ) => {
    const res = await request(method, `/api/v1${path}`, { key, json });
    expect(res.status, `${method} ${path}`).toBeLessThan(300);
    return (await res.json()) as { key: string };
  };
  await send("POST", "/products", bot.key, { key: productKey, name: tag });
  const filed = await send("POST", "/items", handled.key, {
    type: "issue",
    product: productKey,
    title: "for the person",
    filed_for: "handler",
  });
  await send("PATCH", `/items/${filed.key}`, bot.key, { status: "done" });
  db.$client.pragma("wal_checkpoint(TRUNCATE)");
  const databasePath = join(dir, `${tag}.db`);
  copyFileSync(db.$client.name, databasePath);
  const stateOf = () => {
    const reader = openDatabase(databasePath);
    try {
      return reader
        .select({ state: issueEndMail.state, error: issueEndMail.lastError })
        .from(issueEndMail)
        .innerJoin(actor, eq(actor.id, issueEndMail.recipientId))
        .where(eq(actor.email, person))
        .get();
    } finally {
      reader.$client.close();
    }
  };
  expect(stateOf()?.state).toBe("pending");
  return { databasePath, stateOf, person, issueKey: filed.key };
}

async function untilNotPending(stateOf: () => { state: string } | undefined) {
  const deadline = Date.now() + 15_000;
  while (stateOf()?.state === "pending" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("the entrypoint starts the issue-ended email worker: a row left pending is picked up after listening", async () => {
  const { databasePath, stateOf } = await pendingCopy("boot");
  // no EMAIL_FROM or RESEND_API_KEY in spawnEntry's env: the worker's visible effect is a skip naming them
  const child = spawnEntry(databasePath);
  const done = exited(child);
  try {
    await listening(child);
    await untilNotPending(stateOf);
    expect(stateOf()).toEqual({
      state: "skipped",
      error: expect.stringContaining("email is off until"),
    });
  } finally {
    child.kill("SIGKILL");
    await done;
  }
}, 40_000);

test("with EMAIL_FROM and RESEND_API_KEY set the entrypoint sends the pending email through Resend, linking to BETTER_AUTH_URL", async () => {
  const { databasePath, stateOf, person, issueKey } =
    await pendingCopy("resend");
  const received: {
    method?: string;
    url?: string;
    headers: object;
    body: string;
  }[] = [];
  const resend = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "49a3999c" }));
    });
  });
  await new Promise<void>((resolve) => resend.listen(0, "127.0.0.1", resolve));
  // the transport's endpoint is fixed to api.resend.com, so the child's fetch sends that origin to the fake
  const preload = join(dir, "fake-resend.mjs");
  writeFileSync(
    preload,
    `const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input.url ?? String(input)));
  return url.origin === "https://api.resend.com"
    ? real(process.env.FAKE_RESEND + url.pathname, init)
    : real(input, init);
};
`,
  );
  const child = spawnEntry(databasePath, {
    imports: [pathToFileURL(preload).href],
    env: {
      EMAIL_FROM: "trail <trail@mail.example.test>",
      RESEND_API_KEY: "re_entry_key",
      FAKE_RESEND: `http://127.0.0.1:${(resend.address() as AddressInfo).port}`,
    },
  });
  const done = exited(child);
  try {
    await listening(child);
    await untilNotPending(stateOf);
    expect(stateOf()).toEqual({ state: "sent", error: null });
    // the copy also holds the other test's pending email: it goes out too
    const mine = received.filter((r) => JSON.parse(r.body).to[0] === person);
    expect(mine).toHaveLength(1);
    const [req] = mine;
    expect(req).toMatchObject({ method: "POST", url: "/emails" });
    expect(req?.headers).toMatchObject({
      authorization: "Bearer re_entry_key",
      "idempotency-key": expect.stringMatching(/^issue-end-mail\//),
    });
    const sent = JSON.parse(req?.body ?? "{}");
    expect(sent).toMatchObject({
      from: "trail <trail@mail.example.test>",
      to: [person],
    });
    expect(sent.text).toContain(
      `${testAuthConfig.BETTER_AUTH_URL}/issues/${issueKey}`,
    );
    expect(sent.headers["List-Unsubscribe"]).toContain(
      `${testAuthConfig.BETTER_AUTH_URL}/unsubscribe/issue-end?person=`,
    );
  } finally {
    child.kill("SIGKILL");
    await done;
    await new Promise((resolve) => resend.close(resolve));
  }
}, 40_000);

test("SIGTERM cuts an issue-ended email send in flight and leaves the row pending for the next start", async () => {
  const { databasePath, stateOf } = await pendingCopy("stopmail");
  // a Resend that never answers: the request ends only when the worker's signal aborts it
  const preload = join(dir, "hung-resend.mjs");
  writeFileSync(
    preload,
    `const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input.url ?? String(input)));
  if (url.origin !== "https://api.resend.com") return real(input, init);
  console.log("resend request started");
  return new Promise((_, reject) =>
    init.signal.addEventListener("abort", () => {
      console.log("resend request aborted");
      reject(init.signal.reason);
    }),
  );
};
`,
  );
  const child = spawnEntry(databasePath, {
    imports: [pathToFileURL(preload).href],
    env: {
      EMAIL_FROM: "trail <trail@mail.example.test>",
      RESEND_API_KEY: "re_entry_key",
    },
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
  }
  const done = exited(child);
  try {
    await listening(child);
    const deadline = Date.now() + 15_000;
    while (
      !output.includes("resend request started") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(output).toContain("resend request started");
    child.kill("SIGTERM");
    expect(await done).toEqual({ code: null, signal: "SIGTERM" });
    // only the worker's stop() aborts that request, and the drain waits for it
    expect(output).toContain("resend request aborted");
    expect(stateOf()).toMatchObject({ state: "pending" });
  } finally {
    child.kill("SIGKILL");
  }
}, 40_000);
