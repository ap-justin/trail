import { eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { actor, invite } from "../db/schema.js";
import { setupTestApp } from "../test-app.js";

const { app, db, bot, viewerOf } = setupTestApp();

const origin = "http://localhost";

type GitHubUser = { id: number; login: string; name: string | null };

/** GitHub's token and user endpoints, answering as `account`; anything else is a test bug. */
function fakeGitHub(account: GitHubUser) {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    seen.push(url);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: "gho_fake",
        token_type: "bearer",
        scope: "read:user,user:email",
      });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ ...account, email: null, avatar_url: "" });
    }
    if (url === "https://api.github.com/user/emails") {
      return Response.json([
        {
          email: `${account.id}@users.noreply.github.com`,
          primary: true,
          verified: true,
        },
      ]);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return seen;
}
afterEach(() => vi.restoreAllMocks());

const sessionCookie = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .find((c) => c.includes("session_token=")) ?? "";

/** Starts a GitHub sign-in as the browser would and completes its callback. */
async function signInWithGitHub(account: GitHubUser) {
  const seen = fakeGitHub(account);
  const start = await app.request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL: "/" }),
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorize = new URL(url);
  expect(authorize.origin + authorize.pathname).toBe(
    "https://github.com/login/oauth/authorize",
  );
  const state = authorize.searchParams.get("state") ?? "";
  const stateCookies = start.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const complete = () =>
    app.request(
      `/api/auth/callback/github?code=fake-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: stateCookies } },
    );
  const callback = await complete();
  return { callback, cookie: sessionCookie(callback), seen, replay: complete };
}

test("an invited account signs in through GitHub and becomes a member with an actor", async () => {
  db.insert(invite)
    .values({ username: "hopper", invitedBy: bot.actor.id })
    .run();
  const { callback, cookie, seen } = await signInWithGitHub({
    id: 9001,
    login: "Hopper",
    name: "Grace Hopper",
  });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/");
  expect(seen).toContain("https://api.github.com/user");
  expect(
    db.select().from(actor).where(eq(actor.githubId, 9001)).get(),
  ).toMatchObject({
    kind: "human",
    displayName: "Grace Hopper",
    githubLogin: "hopper",
  });
  expect(await viewerOf(cookie)).toMatchObject({
    kind: "member",
    login: "hopper",
    actor: { githubId: 9001 },
  });
});

test("a non-invited account signs in through GitHub as not_invited, with no actor", async () => {
  const { callback, cookie } = await signInWithGitHub({
    id: 9002,
    login: "nobody-asked",
    name: null,
  });
  expect(callback.status).toBe(302);
  expect(await viewerOf(cookie)).toEqual({
    kind: "not_invited",
    login: "nobody-asked",
  });
  expect(db.select().from(actor).where(eq(actor.githubId, 9002)).all()).toEqual(
    [],
  );
});

test("a callback whose state was not issued to this browser makes no session", async () => {
  fakeGitHub({ id: 9003, login: "replayer", name: null });
  const res = await app.request(
    "/api/auth/callback/github?code=fake-code&state=forged",
  );
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toMatch(/error=/);
  expect(sessionCookie(res)).toBe("");
});

test("a callback replayed with the same state makes no second session", async () => {
  const { cookie, replay } = await signInWithGitHub({
    id: 9004,
    login: "twice",
    name: null,
  });
  expect(cookie).not.toBe("");
  const again = await replay();
  expect(again.headers.get("location")).toMatch(/error=/);
  expect(sessionCookie(again)).toBe("");
});
