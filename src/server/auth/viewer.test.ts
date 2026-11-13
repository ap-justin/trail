import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import {
  actor,
  invite as inviteTable,
  project,
  projectMember,
} from "../db/schema.js";
import { projectKey, setupTestApp, TEST_OWNER_ID } from "../test-app.js";

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
  const viewer = await viewerOf(
    await signIn(owner, { githubId: TEST_OWNER_ID }),
  );
  expect(viewer).toMatchObject({ kind: "owner", login: owner });
  expect(viewer.kind === "owner" && viewer.projects.map((p) => p.id)).toEqual(
    expect.arrayContaining([a.id, b.id]),
  );
});

/**
 * Binds the owner to TEST_OWNER_ID by its first sign-in, as the tests that need
 * an owner already bound do for themselves; a repeat sign-in is the same account.
 */
const bindOwner = () => signIn(owner, { githubId: TEST_OWNER_ID });

const invite = (username: string, ...projectIds: string[]) => {
  const { id: inviteId } = db
    .insert(inviteTable)
    .values({ username, invitedBy: bot.actor.id })
    .returning()
    .get();
  for (const projectId of projectIds) {
    db.insert(projectMember).values({ inviteId, projectId }).run();
  }
  return inviteId;
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
  expect(
    await viewerOf(
      await signIn(owner.toUpperCase(), { githubId: TEST_OWNER_ID }),
    ),
  ).toMatchObject({ kind: "owner", login: owner });
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
  const inviteId = invite("barbara");
  const cookie = await signIn("barbara");
  expect(await viewerOf(cookie)).toMatchObject({ projects: [] });
  const added = addProject();
  db.insert(projectMember).values({ inviteId, projectId: added.id }).run();
  expect(await viewerOf(cookie)).toMatchObject({
    projects: [{ id: added.id }],
  });
});

test("an account invited after it signed in is a member once it signs in again", async () => {
  const cookie = await signIn("late", { githubId: 400 });
  expect((await viewerOf(cookie)).kind).toBe("not_invited");
  invite("late");
  expect(await viewerOf(cookie)).toEqual({
    kind: "not_invited",
    login: "late",
  });
  expect(db.select().from(actor).where(eq(actor.githubId, 400)).all()).toEqual(
    [],
  );
  expect(await viewerOf(await signIn("late", { githubId: 400 }))).toMatchObject(
    { kind: "member", actor: { githubId: 400, githubLogin: "late" } },
  );
});

test("an account renamed since its sign-in does not claim an invite later made for its old login", async () => {
  // 410 signs in as alice, then renames on GitHub and frees alice; 411 registers it
  const stale = await signIn("alice", { githubId: 410 });
  invite("alice");
  expect(await viewerOf(stale)).toEqual({
    kind: "not_invited",
    login: "alice",
  });
  expect(
    db
      .select()
      .from(inviteTable)
      .where(eq(inviteTable.username, "alice"))
      .get(),
  ).toMatchObject({ githubId: null });
  expect(db.select().from(actor).where(eq(actor.githubId, 410)).all()).toEqual(
    [],
  );
  expect(
    await viewerOf(await signIn("alice", { githubId: 411 })),
  ).toMatchObject({
    kind: "member",
    actor: { githubId: 411, githubLogin: "alice" },
  });
  expect((await viewerOf(stale)).kind).toBe("not_invited");
});

test("a member's request under its old login leaves the login with the account now holding it", async () => {
  invite("bea");
  invite("bea-new");
  // 420 is bea, renames to bea-renamed and has not signed in since; 421 renames bea-new to bea
  const stale = await signIn("bea", { githubId: 420 });
  await signIn("bea-new", { githubId: 421 });
  const current = await signIn("bea", { githubId: 421 });
  expect(await viewerOf(stale)).toMatchObject({
    kind: "member",
    actor: { githubId: 420 },
  });
  expect(
    db
      .select({ githubId: actor.githubId, githubLogin: actor.githubLogin })
      .from(actor)
      .where(eq(actor.githubLogin, "bea"))
      .all(),
  ).toEqual([{ githubId: 421, githubLogin: "bea" }]);
  expect(await viewerOf(current)).toMatchObject({
    kind: "member",
    actor: { githubId: 421, githubLogin: "bea" },
  });
});

test("a renamed member keeps its access, and its projects, under the new login", async () => {
  const mine = addProject();
  invite("old-name", mine.id);
  await signIn("old-name", { githubId: 500 });
  const before = db.select().from(actor).where(eq(actor.githubId, 500)).get();
  const cookie = await signIn("new-name", { githubId: 500 });
  expect(await viewerOf(cookie)).toMatchObject({
    kind: "member",
    login: "new-name",
    actor: { id: before?.id, githubLogin: "new-name" },
    projects: [{ id: mine.id }],
  });
  expect(db.select().from(actor).where(eq(actor.githubId, 500)).get()).toEqual({
    ...before,
    githubLogin: "new-name",
  });
});

test("whoever registers a member's old login after a rename is not invited", async () => {
  const mine = addProject();
  invite("taken", mine.id);
  // 600 renames on GitHub and never signs in again, so its actor keeps the old login
  await signIn("taken", { githubId: 600 });
  const cookie = await signIn("taken", { githubId: 601 });
  expect(await viewerOf(cookie)).toEqual({
    kind: "not_invited",
    login: "taken",
  });
  expect(db.select().from(actor).where(eq(actor.githubId, 601)).all()).toEqual(
    [],
  );
});

test("whoever registers the owner's old login after a rename is neither owner nor member", async () => {
  await bindOwner();
  // the owner renames on GitHub and has not signed in since
  const cookie = await signIn(owner, { githubId: 700 });
  expect(await viewerOf(cookie)).toEqual({ kind: "not_invited", login: owner });
  expect(db.select().from(actor).where(eq(actor.githubId, 700)).all()).toEqual(
    [],
  );
});

test("a renamed owner is still the owner", async () => {
  await bindOwner();
  const cookie = await signIn("owner-renamed", { githubId: TEST_OWNER_ID });
  expect(await viewerOf(cookie)).toMatchObject({
    kind: "owner",
    login: "owner-renamed",
    actor: { githubId: TEST_OWNER_ID },
  });
});

test("an owner's old login another account now holds is cleared from the owner's actor", async () => {
  await bindOwner();
  // the owner renames on GitHub, then 701 holds the owner's old login, invited under it
  await signIn("owner-renamed", { githubId: TEST_OWNER_ID });
  const stale = db
    .select()
    .from(actor)
    .where(eq(actor.githubId, TEST_OWNER_ID))
    .get();
  expect(stale?.githubLogin).toBe("owner-renamed");
  invite("owner-renamed");
  const cookie = await signIn("owner-renamed", { githubId: 701 });
  expect(await viewerOf(cookie)).toMatchObject({
    kind: "member",
    actor: { githubId: 701, githubLogin: "owner-renamed" },
  });
  expect(
    db.select().from(actor).where(eq(actor.githubId, TEST_OWNER_ID)).get(),
  ).toMatchObject({ githubLogin: null, isOwner: true });
});

test("two accounts claiming one invite at once: exactly one gets it", async () => {
  invite("contested");
  const cookies = await Promise.all([
    signIn("contested", { githubId: 800 }),
    signIn("contested", { githubId: 801 }),
  ]);
  const kinds = await Promise.all(
    cookies.map(async (c) => (await viewerOf(c)).kind),
  );
  expect(kinds.sort()).toEqual(["member", "not_invited"]);
});

test("a signed-in request that changes nothing resolves while a bot holds the write lock", async () => {
  await bindOwner();
  invite("steady");
  const member = await signIn("steady");
  const ownerCookie = await signIn("owner-steady", { githubId: TEST_OWNER_ID });
  const stranger = await signIn("steady-stranger");

  const writer = new Database(db.$client.name);
  writer.exec("BEGIN IMMEDIATE");
  // fail at once instead of after busy_timeout if the resolve asks for the lock
  const busyTimeout = db.$client.pragma("busy_timeout", { simple: true });
  db.$client.pragma("busy_timeout = 0");
  try {
    expect((await viewerOf(member)).kind).toBe("member");
    expect((await viewerOf(ownerCookie)).kind).toBe("owner");
    expect((await viewerOf(stranger)).kind).toBe("not_invited");
  } finally {
    db.$client.pragma(`busy_timeout = ${busyTimeout}`);
    writer.exec("ROLLBACK");
    writer.close();
  }
});
