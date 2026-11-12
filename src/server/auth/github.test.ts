import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { account, actor, invite, user } from "../db/schema.js";
import {
  sessionCookie,
  setupTestApp,
  TEST_ORIGIN,
  testAuthConfig,
} from "../test-app.js";
import { createAuth } from "./auth.js";

const { app, db, bot, viewerOf, signIn, signInWithGitHub } = setupTestApp();

test("sign-in sends the browser to GitHub's authorize page with our redirect", async () => {
  const { authorizeURL } = await signInWithGitHub({
    id: 9000,
    login: "redirected",
    name: null,
  });
  expect(authorizeURL.origin + authorizeURL.pathname).toBe(
    "https://github.com/login/oauth/authorize",
  );
  expect(authorizeURL.searchParams.get("redirect_uri")).toBe(
    "http://localhost/api/auth/callback/github",
  );
});

test("sign-in asks GitHub for its account chooser, so a different account can be picked", async () => {
  const { authorizeURL } = await signInWithGitHub({
    id: 9010,
    login: "chooser",
    name: null,
  });
  expect(authorizeURL.searchParams.get("prompt")).toBe("select_account");
});

test("an invited account signs in through GitHub and becomes a member with an actor", async () => {
  db.insert(invite)
    .values({ username: "hopper", invitedBy: bot.actor.id })
    .run();
  const { callback, cookie } = await signInWithGitHub({
    id: 9001,
    login: "Hopper",
    name: "Grace Hopper",
  });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/");
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

test("no GitHub token is stored, on the first sign-in or a later one", async () => {
  await signIn("tokenless", { githubId: 9005 });
  await signIn("tokenless", { githubId: 9005 });
  const { id } = db
    .select()
    .from(user)
    .where(eq(user.githubId, 9005))
    .get() as { id: string };
  expect(
    db
      .select({
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        idToken: account.idToken,
      })
      .from(account)
      .where(eq(account.userId, id))
      .all(),
  ).toEqual([{ accessToken: null, refreshToken: null, idToken: null }]);
});

test("an account whose email another account signed in with still signs in, as itself", async () => {
  await signInWithGitHub({
    id: 9020,
    login: "personal",
    name: null,
    email: "moved@example.com",
  });
  db.insert(invite).values({ username: "work", invitedBy: bot.actor.id }).run();
  const { callback, cookie } = await signInWithGitHub({
    id: 9021,
    login: "work",
    name: null,
    email: "moved@example.com",
  });
  expect(callback.headers.get("location")).toBe("/");
  expect(await viewerOf(cookie)).toMatchObject({
    kind: "member",
    login: "work",
    actor: { githubId: 9021 },
  });
});

test("a returning account whose row still holds a real email signs in, and so does a new account with that email", async () => {
  await signIn("legacy", { githubId: 9030 });
  db.update(user)
    .set({ email: "shared@example.com" })
    .where(eq(user.githubId, 9030))
    .run();
  const newcomer = await signInWithGitHub({
    id: 9031,
    login: "newcomer",
    name: null,
    email: "shared@example.com",
  });
  expect(await viewerOf(newcomer.cookie)).toEqual({
    kind: "not_invited",
    login: "newcomer",
  });
  const returning = await signInWithGitHub({
    id: 9030,
    login: "legacy",
    name: null,
    email: "shared@example.com",
  });
  expect(await viewerOf(returning.cookie)).toEqual({
    kind: "not_invited",
    login: "legacy",
  });
  expect(
    db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.githubId, 9030))
      .get(),
  ).toEqual({ email: "9030@users.noreply.github.com" });
});

test("an account renamed since its sign-in does not claim the owner seat later named for its old login", async () => {
  // 9040 signs in as heir and renames on GitHub; trail is then redeployed naming
  // heir, the login's new holder, as the owner
  const { cookie } = await signInWithGitHub({
    id: 9040,
    login: "heir",
    name: null,
  });
  const redeployed = createAuth({
    db,
    config: { ...testAuthConfig, TRAIL_OWNER_GITHUB: "heir" },
  });
  expect(await redeployed.resolveViewer(new Headers({ cookie }))).toEqual({
    kind: "not_invited",
    login: "heir",
  });
  expect(db.select().from(actor).where(eq(actor.isOwner, true)).all()).toEqual(
    [],
  );
});

/** Where a callback sent the browser, resolved against the app's origin. */
const redirectOf = (res: Response) =>
  new URL(res.headers.get("location") ?? "", TEST_ORIGIN);

test("a callback whose state was not issued to this browser makes no session and comes back to /sign-in", async () => {
  const res = await app.request(
    "/api/auth/callback/github?code=fake-code&state=forged",
  );
  expect(res.status).toBe(302);
  const to = redirectOf(res);
  expect(to.origin + to.pathname).toBe(`${TEST_ORIGIN}/sign-in`);
  expect(to.searchParams.get("error")).toBeTruthy();
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

test("pressing Cancel on GitHub's consent screen comes back to /sign-in with access_denied", async () => {
  const start = await app.request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL: "/" }),
  });
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state") ?? "";
  const cookie = start.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const res = await app.request(
    `/api/auth/callback/github?error=access_denied&error_description=denied&state=${encodeURIComponent(state)}`,
    { headers: { cookie } },
  );
  const to = redirectOf(res);
  expect(res.status).toBe(302);
  expect(to.origin + to.pathname).toBe(`${TEST_ORIGIN}/sign-in`);
  expect(to.searchParams.get("error")).toBe("access_denied");
  expect(sessionCookie(res)).toBe("");
});
