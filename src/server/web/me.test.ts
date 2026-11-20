import { expect, test } from "vitest";
import { setupTestApp, TEST_OWNER_ID } from "../test-app.js";

const { request, signIn, owner, addMember, addProject } = setupTestApp();

const me = async (cookie?: string) => {
  const res = await request("GET", "/api/web/me", { key: null, cookie });
  // biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
  return { status: res.status, body: (await res.json()) as any };
};

test("an anonymous visitor gets 200 with no login, actor or products, and the owner's login as ownerName before the owner signs in", async () => {
  expect(await me()).toEqual({
    status: 200,
    body: {
      state: "anonymous",
      login: null,
      email: null,
      actor: null,
      products: [],
      ownerName: owner,
      emailSignIn: true,
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
      email: null,
      actor: null,
      products: [],
      ownerName: owner,
      emailSignIn: true,
    },
  });
});

test("a member gets its actor and exactly its products; the owner's display name replaces the login once the owner has signed in", async () => {
  const mine = addProject("Mine");
  addProject("Theirs");
  const cookie = await addMember("sam", [mine.id], { name: "Sam Rivera" });
  await signIn(owner, { name: "Olive Owner" });
  expect(await me(cookie)).toEqual({
    status: 200,
    body: {
      state: "member",
      login: "sam",
      email: null,
      actor: {
        id: expect.any(String),
        name: "Sam Rivera",
        kind: "human",
        photoUrl: null,
        title: null,
      },
      products: [{ key: mine.key, name: "Mine", kind: "product" }],
      ownerName: "Olive Owner",
      emailSignIn: true,
    },
  });
});

test("the owner is state owner and sees every project", async () => {
  const a = addProject();
  const res = await me(await signIn(owner));
  expect(res.body).toMatchObject({ state: "owner", login: owner });
  expect(res.body.products).toContainEqual({
    key: a.key,
    name: a.name,
    kind: "product",
  });
});

test("ownerName follows the owner's account, not its login: a renamed owner keeps its name, and whoever later takes the old login is not the owner", async () => {
  await signIn(owner, { name: "Olive Owner" });
  const renamed = await signIn("olive-renamed", { githubId: TEST_OWNER_ID });
  const squatter = await signIn(owner, { githubId: 4242, name: "Mallory" });
  expect((await me(renamed)).body).toMatchObject({
    state: "owner",
    login: "olive-renamed",
    ownerName: "Olive Owner",
  });
  expect((await me(squatter)).body).toMatchObject({
    state: "not_invited",
    ownerName: "Olive Owner",
  });
});

test("each product carries its kind: a team row is team, any other is product", async () => {
  const product = addProject("Plain");
  const team = addProject("Crew");
  await request("PATCH", `/api/v1/products/${team.key}`, {
    json: { kind: "team" },
  });
  const { body } = await me(await signIn(owner));
  expect(body.products).toContainEqual({
    key: product.key,
    name: "Plain",
    kind: "product",
  });
  expect(body.products).toContainEqual({
    key: team.key,
    name: "Crew",
    kind: "team",
  });
});
