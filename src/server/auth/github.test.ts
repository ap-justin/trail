import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { account, actor, invite, user } from "../db/schema.js";
import { sessionCookie, setupTestApp } from "../test-app.js";

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

test("a callback whose state was not issued to this browser makes no session", async () => {
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
