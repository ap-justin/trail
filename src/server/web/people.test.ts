import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { actor } from "../db/schema.js";
import { setupTestApp } from "../test-app.js";

const { db, request, signIn, owner, addMember, addProject } = setupTestApp();

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
])("inviting %s is a %i", async (_, { username }, status) => {
  await people("POST", "/people", { username: "repeat", projectKeys: [] });
  const res = await people("POST", "/people", { username, projectKeys: [] });
  expect(res.status).toBe(status);
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

test("DELETE removes the invite: the person is shut out at once, and its actor stays", async () => {
  const cookie = await addMember("leaver", [alpha.id], { githubId: 9001 });
  expect((await as(cookie)("GET", "/projects")).status).toBe(200);
  const res = await people("DELETE", "/people/leaver");
  expect(res).toEqual({ status: 204, body: null });
  expect((await as(cookie)("GET", "/projects")).status).toBe(403);
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
