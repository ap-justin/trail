import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { accessOfEmail, syncEmailActor } from "../auth/identity.js";
import { actor } from "../db/schema.js";
import { setupTestApp } from "../test-app.js";

const {
  db,
  request,
  signIn,
  owner,
  addMember,
  addProject,
  inviteEmail,
  signInWithEmail,
  viewerOf,
} = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = any;

const ownerCookie = await signIn(owner, { name: "Olive Owner" });
const alpha = addProject("Alpha");
const beta = addProject("Beta");

const as =
  (cookie: string) => async (method: string, path: string, json?: unknown) => {
    const res = await request(method, `/api/web${path}`, {
      key: null,
      cookie,
      json,
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text ? JSON.parse(text) : null) as Body,
    };
  };
const people = as(ownerCookie);

test("the owner invites a username, lowercased, to projects; it is pending until that account signs in", async () => {
  const created = await people("POST", "/people", {
    username: "  New-Person ",
    projectKeys: [alpha.key.toLowerCase(), beta.key],
  });
  expect(created).toEqual({
    status: 201,
    body: {
      username: "new-person",
      email: null,
      owner: false,
      pending: true,
      name: null,
      photoUrl: null,
      projects: [
        { key: alpha.key, name: "Alpha" },
        { key: beta.key, name: "Beta" },
      ],
      invitedAt: expect.any(String),
    },
  });

  await signIn("New-Person", { name: "Newt" });
  const { status, body } = await people("GET", "/people");
  expect(status).toBe(200);
  expect(body.items[0]).toEqual({
    username: owner,
    email: null,
    owner: true,
    pending: false,
    name: "Olive Owner",
    photoUrl: null,
    projects: expect.arrayContaining([{ key: alpha.key, name: "Alpha" }]),
    invitedAt: null,
  });
  expect(body.items).toContainEqual({
    ...created.body,
    pending: false,
    name: "Newt",
  });
});

test.each([
  ["a repeat of an invited username", { username: "repeat" }, 409],
  ["the owner's username", { username: owner.toUpperCase() }, 409],
  ["a username GitHub would refuse", { username: "-bad-" }, 422],
  ["a username with a double hyphen", { username: "a--b" }, 422],
  ["a 40-character username", { username: "a".repeat(40) }, 422],
  ["a repeat of an invited email", { username: "repeat@example.com" }, 409],
  ["an email cut short", { username: "devon@" }, 422],
  ["an email with no dotted domain", { username: "devon@example" }, 422],
  ["an email with two @", { username: "de@von@example.com" }, 422],
  [
    "a 255-character email",
    { username: `${"a".repeat(243)}@example.com` },
    422,
  ],
])("inviting %s is a %i", async (_, { username }, status) => {
  await people("POST", "/people", { username: "repeat", projectKeys: [] });
  await people("POST", "/people", {
    username: "repeat@example.com",
    projectKeys: [],
  });
  const res = await people("POST", "/people", { username, projectKeys: [] });
  expect(res.status).toBe(status);
});

test("the owner invites an email address, lowercased, to projects; it is pending until that address signs in", async () => {
  const created = await people("POST", "/people", {
    username: "  Priya@Studio.Example ",
    projectKeys: [alpha.key],
  });
  expect(created).toEqual({
    status: 201,
    body: {
      username: null,
      email: "priya@studio.example",
      owner: false,
      pending: true,
      name: null,
      photoUrl: null,
      projects: [{ key: alpha.key, name: "Alpha" }],
      invitedAt: expect.any(String),
    },
  });

  syncEmailActor(db, "priya@studio.example");
  const { body } = await people("GET", "/people");
  expect(body.items).toContainEqual({
    ...created.body,
    pending: false,
    name: "priya",
  });
});

test("the list carries both kinds of invite, oldest first, after the owner", async () => {
  await people("POST", "/people", { username: "both-gh", projectKeys: [] });
  await people("POST", "/people", {
    username: "both@example.com",
    projectKeys: [],
  });
  const { body } = await people("GET", "/people");
  const handles = body.items.map((p: Body) => p.username ?? p.email);
  expect(handles[0]).toBe(owner);
  expect(handles.indexOf("both-gh")).toBeGreaterThan(0);
  expect(handles.indexOf("both@example.com")).toBeGreaterThan(
    handles.indexOf("both-gh"),
  );
});

test("an entry that is neither a GitHub username nor an email address is a 422 saying what to enter", async () => {
  const res = await people("POST", "/people", {
    username: "devon@",
    projectKeys: [],
  });
  expect(res).toEqual({
    status: 422,
    body: {
      error: {
        code: "validation_failed",
        message:
          "Enter a GitHub username or an email address, like devon-r or devon@example.com.",
      },
    },
  });
});

test.each([
  ["an email", "dana@example.com", "DANA@example.com", "dana@example.com"],
  ["a GitHub username", "kai-dev", "Kai-Dev", "@kai-dev"],
])(
  "inviting %s again, in any case, is a 409 naming it",
  async (_, first, again, named) => {
    await people("POST", "/people", { username: first, projectKeys: [] });
    const res = await people("POST", "/people", {
      username: again,
      projectKeys: [],
    });
    expect(res).toEqual({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: `${named} is already invited. Change their projects in the list below.`,
        },
      },
    });
  },
);

test("PUT and DELETE name an email invite by its address, in any case", async () => {
  await people("POST", "/people", {
    username: "edit@example.com",
    projectKeys: [alpha.key],
  });
  syncEmailActor(db, "edit@example.com");
  const path = `/people/${encodeURIComponent("Edit@Example.com")}`;

  const moved = await people("PUT", path, { projectKeys: [beta.key] });
  expect(moved.status).toBe(200);
  expect(moved.body).toMatchObject({
    email: "edit@example.com",
    projects: [{ key: beta.key, name: "Beta" }],
  });

  expect(await people("DELETE", path)).toEqual({ status: 204, body: null });
  expect(accessOfEmail(db, "edit@example.com")).toBeNull();
  expect((await people("DELETE", path)).status).toBe(404);
  expect(
    (await people("PUT", "/people/ghost@example.com", { projectKeys: [] }))
      .status,
  ).toBe(404);
});

test("an unknown project key is a 422 naming the key, and invites no one", async () => {
  const res = await people("POST", "/people", {
    username: "keyless",
    projectKeys: [alpha.key, "NOPE"],
  });
  expect(res.status).toBe(422);
  expect(res.body.error.message).toContain("NOPE");
  const list = await people("GET", "/people");
  expect(list.body.items.map((p: Body) => p.username)).not.toContain("keyless");
});

test("PUT replaces a person's projects, and the member sees exactly the new set on its next request", async () => {
  const cookie = await addMember("mover", [alpha.id]);
  const moved = await people("PUT", "/people/Mover", {
    projectKeys: [beta.key],
  });
  expect(moved.status).toBe(200);
  expect(moved.body.projects).toEqual([{ key: beta.key, name: "Beta" }]);
  const me = await as(cookie)("GET", "/me");
  expect(me.body.projects).toEqual([{ key: beta.key, name: "Beta" }]);

  const emptied = await people("PUT", "/people/mover", { projectKeys: [] });
  expect(emptied.body.projects).toEqual([]);
  expect((await as(cookie)("GET", "/projects")).body.items).toEqual([]);
});

test("PUT or DELETE of a username with no invite is a 404", async () => {
  expect(
    (await people("PUT", "/people/ghost", { projectKeys: [] })).status,
  ).toBe(404);
  expect((await people("DELETE", "/people/ghost")).status).toBe(404);
  expect((await people("DELETE", `/people/${owner}`)).status).toBe(404);
});

test("DELETE removes the invite: the person is signed out at once, and its actor stays", async () => {
  const cookie = await addMember("leaver", [alpha.id], { githubId: 9001 });
  expect((await as(cookie)("GET", "/projects")).status).toBe(200);
  const res = await people("DELETE", "/people/leaver");
  expect(res).toEqual({ status: 204, body: null });
  expect((await as(cookie)("GET", "/projects")).status).toBe(401);
  expect(
    db.select().from(actor).where(eq(actor.githubId, 9001)).get(),
  ).toMatchObject({
    githubLogin: "leaver",
  });
});

test.each([
  ["GET", "/people"],
  ["POST", "/people"],
  ["PUT", "/people/anyone"],
  ["DELETE", "/people/anyone"],
])(
  "%s %s is, for a member, the same 404 as a route that does not exist",
  async (method, path) => {
    const member = as(await addMember(`m${method.toLowerCase()}`, [alpha.id]));
    const json =
      method === "GET" ? undefined : { username: "x", projectKeys: [] };
    const res = await member(method, path, json);
    expect(res).toEqual({
      status: 404,
      body: {
        error: {
          code: "not_found",
          message: `no route ${method} /api/web${path}`,
        },
      },
    });
  },
);

test("an invite is pending until an account claims it, and then shows that account's name whatever its login becomes", async () => {
  await people("POST", "/people", { username: "ren", projectKeys: [] });
  await signIn("ren", { githubId: 7001, name: "Ren Original" });
  await signIn("ren-new", { githubId: 7001, name: "Ren Renamed" });
  // the account now holding ren-new already claimed "ren", so this invite stays unclaimed
  await people("POST", "/people", { username: "ren-new", projectKeys: [] });
  await signIn("ren-new", { githubId: 7001 });

  const { body } = await people("GET", "/people");
  const row = (username: string) =>
    body.items.find((p: Body) => p.username === username);
  expect(row("ren")).toMatchObject({ pending: false, name: "Ren Original" });
  expect(row("ren-new")).toMatchObject({ pending: true, name: null });
});

test("a 77-character username that only fits the shape is a 422", async () => {
  const res = await people("POST", "/people", {
    username: `a${"-b".repeat(38)}`,
    projectKeys: [],
  });
  expect(res.status).toBe(422);
});

test("removing a GitHub invite ends its sessions, so a re-invite needs a fresh sign-in", async () => {
  const cookie = await addMember("returner", [alpha.id], { githubId: 5001 });
  const other = await addMember("stayer", [alpha.id]);
  expect(await viewerOf(cookie)).toMatchObject({ kind: "member" });
  expect((await people("DELETE", "/people/returner")).status).toBe(204);
  expect(
    (await people("POST", "/people", { username: "returner", projectKeys: [] }))
      .status,
  ).toBe(201);
  expect(await viewerOf(cookie)).toEqual({ kind: "anonymous" });
  expect(await viewerOf(other)).toMatchObject({ kind: "member" });
  expect(await viewerOf(ownerCookie)).toMatchObject({ kind: "owner" });
});

test("removing an email invite ends its sessions, so a re-invite needs a fresh sign-in", async () => {
  inviteEmail("again@example.com", [alpha.id]);
  const cookie = await signInWithEmail("again@example.com");
  expect(await viewerOf(cookie)).toMatchObject({ kind: "member" });
  expect((await people("DELETE", "/people/again@example.com")).status).toBe(
    204,
  );
  expect(
    (
      await people("POST", "/people", {
        username: "again@example.com",
        projectKeys: [alpha.key],
      })
    ).status,
  ).toBe(201);
  expect(await viewerOf(cookie)).toEqual({ kind: "anonymous" });
  expect(
    await viewerOf(await signInWithEmail("again@example.com")),
  ).toMatchObject({ kind: "member" });
});

test("a GitHub handle typed with a leading @ is the username, in POST, PUT and DELETE", async () => {
  const created = await people("POST", "/people", {
    username: " @At-Handle ",
    projectKeys: [alpha.key],
  });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ username: "at-handle", email: null });

  const path = `/people/${encodeURIComponent("@At-Handle")}`;
  const moved = await people("PUT", path, { projectKeys: [beta.key] });
  expect(moved.status).toBe(200);
  expect(moved.body).toMatchObject({
    username: "at-handle",
    projects: [{ key: beta.key, name: "Beta" }],
  });
  expect(await people("DELETE", path)).toEqual({ status: 204, body: null });
  expect((await people("DELETE", "/people/at-handle")).status).toBe(404);
});

test.each(["@@double", "@dana@example.com", "@"])(
  "%j is neither a handle nor an address",
  async (entry) => {
    expect(
      (await people("POST", "/people", { username: entry, projectKeys: [] }))
        .status,
    ).toBe(422);
  },
);
