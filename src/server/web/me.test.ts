import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const { request, signIn, owner, addMember, addProject } = setupTestApp();

const me = async (cookie?: string) => {
  const res = await request("GET", "/api/web/me", { key: null, cookie });
  // biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
  return { status: res.status, body: (await res.json()) as any };
};

test("an anonymous visitor gets 200 with no login, actor or projects, and the owner's login as ownerName before the owner signs in", async () => {
  expect(await me()).toEqual({
    status: 200,
    body: {
      state: "anonymous",
      login: null,
      actor: null,
      projects: [],
      ownerName: owner,
    },
  });
});

test("an account not on the list gets 200 not_invited with its login and nothing else", async () => {
  addProject();
  expect(await me(await signIn("Stranger"))).toEqual({
    status: 200,
    body: {
      state: "not_invited",
      login: "stranger",
      actor: null,
      projects: [],
      ownerName: owner,
    },
  });
});

test("a member gets its actor and exactly its projects; the owner's display name replaces the login once the owner has signed in", async () => {
  const mine = addProject("Mine");
  addProject("Theirs");
  const cookie = await addMember("ada", [mine.id], { name: "Ada Lovelace" });
  await signIn(owner, { name: "Olive Owner" });
  expect(await me(cookie)).toEqual({
    status: 200,
    body: {
      state: "member",
      login: "ada",
      actor: { id: expect.any(String), name: "Ada Lovelace", kind: "human" },
      projects: [{ key: mine.key, name: "Mine" }],
      ownerName: "Olive Owner",
    },
  });
});

test("the owner is state owner and sees every project", async () => {
  const a = addProject();
  const res = await me(await signIn(owner));
  expect(res.body).toMatchObject({ state: "owner", login: owner });
  expect(res.body.projects).toContainEqual({ key: a.key, name: a.name });
});
