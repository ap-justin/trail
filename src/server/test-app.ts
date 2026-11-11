import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestHelpers } from "better-auth/plugins";
import { testUtils } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { afterAll, vi } from "vitest";
import { createApp } from "./app.js";
import { type AuthConfig, createAuth } from "./auth/auth.js";
import { migrate, openDatabase } from "./db/client.js";
import { user } from "./db/schema.js";
import { type ActivityEvent, createEventBus } from "./events/bus.js";
import { createBot } from "./service/keys.js";

/** The owner's login in every test app. */
export const TEST_OWNER = "trail-owner";

const testAuthConfig: AuthConfig = {
  TRAIL_OWNER_GITHUB: TEST_OWNER,
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  BETTER_AUTH_URL: undefined,
  github: { clientId: "test-client-id", clientSecret: "test-client-secret" },
};

/**
 * The app over a fresh migrated SQLite file, removed after the test file, with
 * one bot and a `request` that sends its key, and `signIn` for a person without
 * GitHub. Call once at a test file's top level.
 */
export function setupTestApp({
  auth: authOverrides = {},
}: {
  auth?: Partial<AuthConfig>;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trail-api-"));
  const db = openDatabase(join(dir, "trail.db"));
  migrate(db);
  afterAll(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const bus = createEventBus();
  const published: ActivityEvent[] = [];
  bus.subscribe((event) => published.push(event));
  const auth = createAuth({
    db,
    config: { ...testAuthConfig, ...authOverrides },
    plugins: [testUtils()],
  });
  const app = createApp({ db, bus, auth });
  const bot = createBot(db, "tester");

  let githubIds = 1000;
  /**
   * Signs in a GitHub account with no GitHub, as the callback would: the same
   * `githubId` again is the same account, under a new login if it changed.
   * Returns the session's Cookie header.
   */
  async function signIn(
    login: string,
    {
      githubId = ++githubIds,
      name = "",
    }: { githubId?: number; name?: string } = {},
  ): Promise<string> {
    const helpers = ((await auth.$context) as unknown as { test: TestHelpers })
      .test;
    const githubLogin = login.toLowerCase();
    const known = db
      .select()
      .from(user)
      .where(eq(user.githubId, githubId))
      .get();
    const userId = known
      ? db
          .update(user)
          .set({ githubLogin, name: name || login })
          .where(eq(user.id, known.id))
          .returning()
          .get().id
      : (
          await helpers.saveUser(
            helpers.createUser({
              email: `${githubId}@users.noreply.github.com`,
              name: name || login,
              githubId,
              githubLogin,
            }),
          )
        ).id;
    const { headers } = await helpers.login({ userId });
    return headers.get("cookie") ?? "";
  }

  /** The viewer a request with this Cookie header resolves to. */
  const viewerOf = (cookie: string) =>
    auth.resolveViewer(new Headers({ cookie }));

  /**
   * Sends `json` as the body and the bot's key unless `key` overrides it (null
   * sends none), and `cookie` as the Cookie header.
   */
  function request(
    method: string,
    path: string,
    {
      json,
      key = bot.key,
      cookie,
    }: { json?: unknown; key?: string | null; cookie?: string } = {},
  ) {
    const headers: Record<string, string> = {};
    if (key !== null) headers.authorization = `Bearer ${key}`;
    if (cookie !== undefined) headers.cookie = cookie;
    if (json !== undefined) headers["content-type"] = "application/json";
    return app.request(path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  }

  /** A further bot with its own key; pass the key to `request` to write as it. */
  const addBot = (name: string) => createBot(db, name);

  return {
    db,
    bus,
    app,
    auth,
    bot,
    addBot,
    published,
    request,
    owner: TEST_OWNER,
    signIn,
    viewerOf,
  };
}

// One clock per test file, an hour in the past and only ever moving forward:
// rows written through it order strictly among themselves and before any row
// written at real time. Ids minted in one millisecond sort randomly.
let fakeNow = Date.now() - 3_600_000;

function stampEach<T>(count: number, stepMs: number, run: (i: number) => T) {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    for (let i = 0; i < count; i++) {
      vi.setSystemTime(fakeNow);
      fakeNow += stepMs;
      run(i);
    }
  } finally {
    vi.useRealTimers();
  }
  fakeNow += 1; // the next batch starts after this one, even at stepMs 0
}

/** Runs each write `stepMs` after the last on the file's fake clock (0 stamps them all alike). */
export function atFakeTime<T>(writes: (() => T)[], stepMs = 1): T[] {
  const results: T[] = [];
  stampEach(writes.length, stepMs, (i) => {
    results.push((writes[i] as () => T)());
  });
  return results;
}

/** `atFakeTime` for REST writes: each is awaited under its own stamp. */
export async function atFakeTimeAsync<T>(
  writes: (() => T | Promise<T>)[],
  stepMs = 1,
): Promise<T[]> {
  const results: T[] = [];
  for (const write of writes) {
    // the Date stays faked until the write's promise settles
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(fakeNow);
      fakeNow += stepMs;
      results.push(await write());
    } finally {
      vi.useRealTimers();
    }
  }
  fakeNow += 1;
  return results;
}

let keys = 0;
/** A project key no other call in this test file has returned. */
export const projectKey = () => `K${(++keys).toString(36).toUpperCase()}`;
