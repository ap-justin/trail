import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";
import { createApp } from "./app.js";
import { type AuthConfig, createAuth } from "./auth/auth.js";
import { migrate, openDatabase } from "./db/client.js";
import { invite, project, projectMember } from "./db/schema.js";
import { type ActivityEvent, createEventBus } from "./events/bus.js";
import { createBot } from "./service/keys.js";
import { type WebhookSettings, webhookSettings } from "./service/webhooks.js";
import { LiveStreams } from "./web/events.js";
import { deriveSecretKey } from "./webhooks/secret.js";

/** The owner's login in every test app, and the GitHub id `signIn` gives it. */
export const TEST_OWNER = "trail-owner";
export const TEST_OWNER_ID = 1;

/** Webhook settings for a test: every name resolves to a public address but internal.example.test, and nothing is sent. */
export const testWebhookSettings = (
  overrides: Partial<
    Pick<WebhookSettings, "resolve" | "transport" | "now" | "publicUrl">
  > = {},
) =>
  webhookSettings(
    deriveSecretKey("test-secret-that-is-at-least-32-characters"),
    {
      resolve: async (host) =>
        host === "internal.example.test" ? ["10.0.0.5"] : ["93.184.216.34"],
      transport: async () => ({ status: 200 }),
      ...overrides,
    },
  );
export const testWebhooks = testWebhookSettings();

/** The origin `app.request` gives a path-only request. */
export const TEST_ORIGIN = "http://localhost";

export const testAuthConfig: AuthConfig = {
  TRAIL_OWNER_GITHUB: TEST_OWNER,
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  BETTER_AUTH_URL: TEST_ORIGIN,
  github: { clientId: "test-client-id", clientSecret: "test-client-secret" },
};

/**
 * A GitHub account as GitHub's /user endpoint describes it, with the primary
 * address /user/emails gives; GitHub's id-keyed noreply address by default.
 */
export type GitHubAccount = {
  id: number;
  login: string;
  name: string | null;
  email?: string;
};

/**
 * Replaces `fetch` until the test file ends: GitHub's token endpoint swaps an
 * authorization code for that code's account's token, and its user and email
 * endpoints answer for the account whose token is sent. A loopback URL goes to
 * the real fetch; any other URL is an error, so no test reaches the network.
 * `issue(account)` returns a code GitHub would redirect back with.
 */
function fakeGitHub() {
  const accounts = new Map<string, GitHubAccount>();
  let codes = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const token = request.headers
      .get("authorization")
      ?.replace(/^Bearer /i, "");
    switch (request.url) {
      case "https://github.com/login/oauth/access_token": {
        const code =
          new URLSearchParams(await request.text()).get("code") ?? "";
        if (!accounts.has(code))
          return Response.json({ error: "bad_verification_code" });
        return Response.json({
          access_token: code,
          refresh_token: `refresh-${code}`,
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      }
      case "https://api.github.com/user": {
        const account = accounts.get(token ?? "");
        if (!account) return new Response(null, { status: 401 });
        return Response.json({ ...account, email: null, avatar_url: "" });
      }
      case "https://api.github.com/user/emails": {
        const account = accounts.get(token ?? "");
        if (!account) return new Response(null, { status: 401 });
        const email = account.email ?? `${account.id}@users.noreply.github.com`;
        return Response.json([{ email, primary: true, verified: true }]);
      }
      default:
        // a test's own server on the loopback is not the network
        if (
          ["127.0.0.1", "localhost", "[::1]"].includes(
            new URL(request.url).hostname,
          )
        )
          return realFetch(input, init);
        throw new Error(`test fetch to an unfaked URL: ${request.url}`);
    }
  };
  afterAll(() => {
    globalThis.fetch = realFetch;
  });
  return {
    issue(account: GitHubAccount) {
      const code = `code-${++codes}`;
      accounts.set(code, account);
      return code;
    },
  };
}

// never answers, so an unrelated sign-in neither stores a photo nor logs a failed fetch
const noAvatar: typeof fetch = () => new Promise(() => {});

/** The `name=value` of the session cookie a response sets, or "". */
export const sessionCookie = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .find((c) => c.includes("session_token=")) ?? "";

/**
 * The app over a fresh migrated SQLite file, removed after the test file, with
 * one bot and a `request` that sends its key, and `signIn` for a person through
 * the app's GitHub sign-in with GitHub faked. Call once at a test file's top level.
 */
export function setupTestApp({
  auth: authOverrides = {},
  avatarFetch = noAvatar,
  webDir,
  webhooks: webhookOverrides = {},
}: {
  auth?: Partial<AuthConfig>;
  /** replaces how webhooks resolve hosts and send; by default every name resolves to a public address and nothing is sent */
  webhooks?: Partial<Pick<WebhookSettings, "resolve" | "transport" | "now">>;
  /** answers sign-in's GitHub photo fetch; by default never, so no photo and no warning */
  avatarFetch?: typeof fetch;
  /** the built SPA directory `createApp` serves; none by default */
  webDir?: string;
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
    avatarFetch,
  });
  const streams = new LiveStreams();
  const webhooks = testWebhookSettings(webhookOverrides);
  const app = createApp({ db, bus, auth, streams, webDir, webhooks });
  const bot = createBot(db, "tester");
  const github = fakeGitHub();

  /**
   * A browser's GitHub sign-in through the app's own routes, with GitHub faked
   * as `account`: start it, then complete the callback. `replay` sends that
   * callback again.
   */
  async function signInWithGitHub(account: GitHubAccount) {
    const start = await app.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ provider: "github", callbackURL: "/" }),
    });
    if (start.status !== 200) {
      throw new Error(
        `sign-in start gave ${start.status}: ${await start.text()}`,
      );
    }
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";
    const stateCookies = start.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const code = github.issue(account);
    const complete = () =>
      app.request(
        `/api/auth/callback/github?code=${code}&state=${encodeURIComponent(state)}`,
        { headers: { cookie: stateCookies } },
      );
    const callback = await complete();
    return {
      authorizeURL: new URL(url),
      callback,
      cookie: sessionCookie(callback),
      replay: complete,
    };
  }

  let githubIds = 1000;
  /**
   * Signs in through the GitHub callback as the account `githubId` currently
   * named `login`; the same id again is the same account, renamed if the login
   * differs. By default the owner's login is TEST_OWNER_ID and any other login
   * a fresh account. Returns the session's Cookie header.
   */
  async function signIn(
    login: string,
    {
      githubId = login.toLowerCase() === TEST_OWNER
        ? TEST_OWNER_ID
        : ++githubIds,
      name = null,
    }: { githubId?: number; name?: string | null } = {},
  ): Promise<string> {
    const { callback, cookie } = await signInWithGitHub({
      id: githubId,
      login,
      name,
    });
    if (!cookie) {
      throw new Error(
        `sign-in as ${login} made no session: ${callback.headers.get("location")}`,
      );
    }
    return cookie;
  }

  /** The viewer a request with this Cookie header resolves to. */
  const viewerOf = (cookie: string) =>
    auth.resolveViewer(new Headers({ cookie }));

  /**
   * Sends `json` as the body and the bot's key unless `key` overrides it (null
   * sends none), and `cookie` as the Cookie header. A non-GET carries the app's
   * own Origin, as a browser on the SPA sends it, unless `origin` overrides it
   * (null sends none).
   */
  function request(
    method: string,
    path: string,
    {
      json,
      key = bot.key,
      cookie,
      origin = TEST_ORIGIN,
    }: {
      json?: unknown;
      key?: string | null;
      cookie?: string;
      origin?: string | null;
    } = {},
  ) {
    const headers: Record<string, string> = {};
    if (key !== null) headers.authorization = `Bearer ${key}`;
    if (cookie !== undefined) headers.cookie = cookie;
    if (origin !== null && method !== "GET") headers.origin = origin;
    if (json !== undefined) headers["content-type"] = "application/json";
    return app.request(path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  }

  /** A further bot with its own key; pass the key to `request` to write as it. */
  const addBot = (name: string) => createBot(db, name);

  /** A project written straight to the database, created by the bot, with no activity event. */
  const addProject = (name = "p") =>
    db
      .insert(project)
      .values({ key: projectKey(), name, createdBy: bot.actor.id })
      .returning()
      .get();

  /** Invites `login` to these projects and signs it in; returns the Cookie header. */
  async function addMember(
    login: string,
    projectIds: string[],
    account: { githubId?: number; name?: string } = {},
  ): Promise<string> {
    db.insert(invite)
      .values({ username: login, invitedBy: bot.actor.id })
      .run();
    for (const projectId of projectIds) {
      db.insert(projectMember).values({ username: login, projectId }).run();
    }
    return signIn(login, account);
  }

  return {
    db,
    bus,
    app,
    auth,
    bot,
    addBot,
    addProject,
    addMember,
    webhooks,
    published,
    request,
    owner: TEST_OWNER,
    signIn,
    signInWithGitHub,
    viewerOf,
    /** Ends every event stream, as a drain does; resolves once each has stopped. */
    endStreams: () => streams.end(),
  };
}

// One clock per test file, an hour in the past and only ever moving forward:
// rows written through it order strictly among themselves and before any row
// written at real time. Ids minted in one millisecond sort randomly.
let fakeNow = Date.now() - 3_600_000;

/**
 * Fakes the Date at `at`; the returned function undoes it, leaving the caller's
 * own fake timers, if any, on as they were. Fake timers the caller has on
 * without the Date cannot take one: installing a second clock would drop their
 * pending timers.
 */
function pinDate(at: number): () => void {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    return () => vi.useRealTimers();
  }
  if (!(Date as { isFake?: boolean }).isFake) {
    throw new Error(
      'atFakeTime needs the Date faked: pass "Date" in toFake to the useFakeTimers that is on',
    );
  }
  const callers = Date.now();
  vi.setSystemTime(at);
  return () => vi.setSystemTime(callers);
}

function stampEach<T>(count: number, stepMs: number, run: (i: number) => T) {
  const unpin = pinDate(fakeNow);
  try {
    for (let i = 0; i < count; i++) {
      vi.setSystemTime(fakeNow);
      fakeNow += stepMs;
      run(i);
    }
  } finally {
    unpin();
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
    const unpin = pinDate(fakeNow);
    try {
      fakeNow += stepMs;
      results.push(await write());
    } finally {
      unpin();
    }
  }
  fakeNow += 1;
  return results;
}

let keys = 0;
/** A project key no other call in this test file has returned. */
export const projectKey = () => `K${(++keys).toString(36).toUpperCase()}`;

export type EventStreamMessage = {
  event?: string;
  id?: string;
  data?: string;
  comment?: string;
};

/** Reads an SSE response one message, or comment line, at a time. */
export function readEventStream(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  /** The next message; null once the stream has ended. */
  async function next(): Promise<EventStreamMessage | null> {
    while (!buffer.includes("\n\n")) {
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
    const end = buffer.indexOf("\n\n");
    const block = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    const message: EventStreamMessage = {};
    for (const line of block.split("\n")) {
      if (line.startsWith(": ")) message.comment = line.slice(2);
      else if (line.startsWith("event: ")) message.event = line.slice(7);
      else if (line.startsWith("id: ")) message.id = line.slice(4);
      else if (line.startsWith("data: ")) message.data = line.slice(6);
    }
    return message;
  }
  /** The next entry's parsed JSON with its id as `seq`, skipping comment lines and named events. */
  async function nextEntry() {
    for (;;) {
      const message = await next();
      if (message === null) return null;
      if (message.data !== undefined && message.event === undefined) {
        // biome-ignore lint/suspicious/noExplicitAny: loose entries for field reads
        return { seq: Number(message.id), ...JSON.parse(message.data) } as any;
      }
    }
  }
  return { next, nextEntry, cancel: () => reader.cancel() };
}
