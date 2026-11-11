import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import {
  actor,
  invite as inviteTable,
  project,
  projectMember,
} from "../db/schema.js";
import { projectKey, setupTestApp } from "../test-app.js";

const { db, bot, owner, signIn, viewerOf } = setupTestApp();

const addProject = () =>
  db
    .insert(project)
    .values({ key: projectKey(), name: "p", createdBy: bot.actor.id })
    .returning()
    .get();

test("the owner signs in as owner and sees every project", async () => {
  const a = addProject();
  const b = addProject();
  const viewer = await viewerOf(await signIn(owner));
  expect(viewer).toMatchObject({ kind: "owner", login: owner });
  expect(viewer.kind === "owner" && viewer.projects.map((p) => p.id)).toEqual(
    expect.arrayContaining([a.id, b.id]),
  );
});

const invite = (username: string, ...projectIds: string[]) => {
  db.insert(inviteTable).values({ username, invitedBy: bot.actor.id }).run();
  for (const projectId of projectIds) {
    db.insert(projectMember).values({ username, projectId }).run();
  }
};

test("an invited account is a member with exactly its projects, and gets an actor on sign-in", async () => {
  const mine = addProject();
  addProject();
  invite("ada", mine.id);
  const cookie = await signIn("ada", { githubId: 42, name: "Ada Lovelace" });
  expect(
    db.select().from(actor).where(eq(actor.githubId, 42)).get(),
  ).toMatchObject({
    kind: "human",
    displayName: "Ada Lovelace",
    githubLogin: "ada",
  });
  expect(await viewerOf(cookie)).toEqual({
    kind: "member",
    login: "ada",
    actor: {
      id: expect.any(String),
      displayName: "Ada Lovelace",
      githubId: 42,
      githubLogin: "ada",
    },
    projects: [{ id: mine.id, key: mine.key, name: "p" }],
  });
});

test("an account neither owner nor invited is not_invited, with its login and no actor", async () => {
  addProject();
  const cookie = await signIn("stranger", { githubId: 77 });
  expect(await viewerOf(cookie)).toEqual({
    kind: "not_invited",
    login: "stranger",
  });
  expect(db.select().from(actor).where(eq(actor.githubId, 77)).all()).toEqual(
    [],
  );
});

test("a GitHub login matches the invite and the owner ignoring case", async () => {
  invite("grace");
  expect(await viewerOf(await signIn("Grace"))).toMatchObject({
    kind: "member",
    login: "grace",
    actor: { githubLogin: "grace" },
  });
  expect(await viewerOf(await signIn(owner.toUpperCase()))).toMatchObject({
    kind: "owner",
    login: owner,
  });
});

test("with no cookie, or a cookie no session matches, the viewer is anonymous", async () => {
  expect(await viewerOf("")).toEqual({ kind: "anonymous" });
  expect(await viewerOf("better-auth.session_token=nope.forged")).toEqual({
    kind: "anonymous",
  });
});

test("removing the invite makes a live session not_invited on its next request", async () => {
  invite("linus");
  const cookie = await signIn("linus");
  expect((await viewerOf(cookie)).kind).toBe("member");
  db.delete(inviteTable).where(eq(inviteTable.username, "linus")).run();
  expect(await viewerOf(cookie)).toEqual({
    kind: "not_invited",
    login: "linus",
  });
});

test("a project added to a member shows on its next request", async () => {
  invite("barbara");
  const cookie = await signIn("barbara");
  expect(await viewerOf(cookie)).toMatchObject({ projects: [] });
  const added = addProject();
  db.insert(projectMember)
    .values({ username: "barbara", projectId: added.id })
    .run();
  expect(await viewerOf(cookie)).toMatchObject({
    projects: [{ id: added.id }],
  });
});

test("an account invited after it signed in is a member on its next request", async () => {
  const cookie = await signIn("late");
  expect((await viewerOf(cookie)).kind).toBe("not_invited");
  invite("late");
  expect(await viewerOf(cookie)).toMatchObject({
    kind: "member",
    actor: { githubLogin: "late" },
  });
});

test("a renamed account is found by its GitHub id and answers to its new login", async () => {
  invite("old-name");
  await signIn("old-name", { githubId: 500 });
  const before = db.select().from(actor).where(eq(actor.githubId, 500)).get();
  const cookie = await signIn("new-name", { githubId: 500 });
  expect(await viewerOf(cookie)).toEqual({
    kind: "not_invited",
    login: "new-name",
  });
  expect(db.select().from(actor).where(eq(actor.githubId, 500)).get()).toEqual({
    ...before,
    githubLogin: "new-name",
  });
});

test("a login another account gave up goes to the account that holds it now", async () => {
  invite("taken");
  // 600 renames on GitHub and never signs in again, so its actor keeps the old login
  await signIn("taken", { githubId: 600 });
  const cookie = await signIn("taken", { githubId: 601 });
  expect(await viewerOf(cookie)).toMatchObject({
    kind: "member",
    actor: { githubId: 601, githubLogin: "taken" },
  });
  expect(
    db.select().from(actor).where(eq(actor.githubId, 600)).get(),
  ).toMatchObject({ githubLogin: null });
});
