import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { MeView } from "../../shared/schemas.js";
import { invite } from "../db/schema.js";
import { sessionCookie, setupTestApp } from "../test-app.js";

const {
  db,
  auth,
  request,
  addProject,
  inviteEmail,
  signInWithEmail,
  requestEmailLink,
  deliveries,
  linkSentTo,
  openLink,
  owner,
} = setupTestApp();

const isLetIn = (cookie: string) => auth.isLetIn(new Headers({ cookie }));

const me = async (cookie: string) =>
  (await (
    await request("GET", "/api/web/me", { key: null, cookie })
  ).json()) as MeView;

const projectKeys = async (cookie: string) => {
  const res = await request("GET", "/api/web/projects", { key: null, cookie });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: { key: string }[] };
  return body.items.map((p) => p.key);
};

test("an email invitee signs in as a member and sees exactly its projects", async () => {
  const mine = addProject("Mine");
  addProject("Theirs");
  inviteEmail("lena@example.com", [mine.id]);
  const cookie = await signInWithEmail("lena@example.com");
  expect(await me(cookie)).toEqual({
    state: "member",
    login: null,
    email: "lena@example.com",
    actor: {
      id: expect.any(String),
      name: "lena",
      kind: "human",
      photoUrl: null,
    },
    projects: [{ key: mine.key, name: "Mine" }],
    ownerName: owner,
    emailSignIn: true,
  });
  expect(await projectKeys(cookie)).toEqual([mine.key]);
  expect(await isLetIn(cookie)).toBe(true);
});

test("signing in again is the same person", async () => {
  inviteEmail("mo@example.com");
  const first = await me(await signInWithEmail("mo@example.com"));
  const again = await me(await signInWithEmail("mo@example.com"));
  expect(again.actor?.id).toBe(first.actor?.id);
});

test("removing the email invite shuts a live session out on its next request", async () => {
  const project = addProject();
  const inviteId = inviteEmail("nia@example.com", [project.id]);
  const cookie = await signInWithEmail("nia@example.com");
  expect(await projectKeys(cookie)).toEqual([project.key]);

  db.delete(invite).where(eq(invite.id, inviteId)).run();
  const res = await request("GET", "/api/web/projects", { key: null, cookie });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({
    error: {
      code: "not_invited",
      message:
        "nia@example.com is not invited: ask the owner to invite your GitHub username or email address, then sign in again",
    },
  });
  expect(await me(cookie)).toMatchObject({
    state: "not_invited",
    login: null,
    email: "nia@example.com",
    actor: null,
    projects: [],
  });
  expect(await isLetIn(cookie)).toBe(false);
});

test("a link whose invite was removed before it was opened signs in as not invited, with no access", async () => {
  const inviteId = inviteEmail("omar@example.com");
  expect((await requestEmailLink("omar@example.com")).status).toBe(200);
  await deliveries();
  db.delete(invite).where(eq(invite.id, inviteId)).run();
  const res = await openLink(linkSentTo("omar@example.com"));
  const cookie = sessionCookie(res);
  expect(cookie).not.toBe("");
  expect(await me(cookie)).toMatchObject({
    state: "not_invited",
    login: null,
    email: "omar@example.com",
    actor: null,
  });
  expect(
    (await request("GET", "/api/web/projects", { key: null, cookie })).status,
  ).toBe(403);
});
