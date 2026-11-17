import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { actor } from "../db/schema.js";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";
import { type Body, webSeed } from "./test-seed.js";

const { db, request, signIn, owner, addMember, addProject } = setupTestApp();
const seed = webSeed(request);

const alpha = addProject("alpha");
const beta = addProject("beta");

/** A todo of the test bot's in `productKey`, in progress; returns its key. */
const working = (productKey: string, title: string) =>
  seed.item(productKey, "todo", { status: "in_progress", title });

const workingNow = async (cookie: string) => {
  const { status, body } = await seed.get("/working-now", cookie);
  expect(status).toBe(200);
  return body as Body;
};

test("a member sees only their products' bot work, and a hidden product adds nothing to the total", async () => {
  const shown = await working(alpha.key, "alpha work");
  await working(beta.key, "beta work");
  const cookie = await addMember("alpha-only", [alpha.id]);
  expect(await workingNow(cookie)).toEqual({
    total: 1,
    entries: [
      {
        item: { key: shown, title: "alpha work" },
        productKey: alpha.key,
        bot: {
          id: expect.any(String),
          name: "tester",
          kind: "bot",
          title: null,
          photoUrl: null,
        },
      },
    ],
  });
});

test("the most recently updated item comes first, not the most recently created", async () => {
  const gamma = addProject("gamma");
  const [first, second] = await atFakeTimeAsync([
    () => working(gamma.key, "started first"),
    () => working(gamma.key, "started second"),
  ]);
  await atFakeTimeAsync([
    () =>
      request("PATCH", `/api/v1/items/${first}`, {
        json: { title: "started first, touched last" },
      }),
  ]);
  const body = await workingNow(await addMember("orderly", [gamma.id]));
  expect(body.entries.map((e: Body) => e.item.key)).toEqual([first, second]);
});

test("entries stop at 12 while total counts every match", async () => {
  const delta = addProject("delta");
  for (let i = 1; i <= 13; i++) await working(delta.key, `busy ${i}`);
  const body = await workingNow(await addMember("busy", [delta.id]));
  expect(body.total).toBe(13);
  expect(body.entries).toHaveLength(12);
});

test("an item assigned to a person, or a bot's item not in progress, is left out", async () => {
  const epsilon = addProject("epsilon");
  await signIn(owner, { name: "Olive Owner" });
  const person = db
    .select({ id: actor.id })
    .from(actor)
    .where(eq(actor.isOwner, true))
    .get();
  await seed.item(epsilon.key, "todo", {
    status: "in_progress",
    assignee: person?.id,
  });
  await seed.item(epsilon.key, "todo");
  await seed.item(epsilon.key, "todo", { status: "done" });
  const kept = await working(epsilon.key, "the bot's work");
  const body = await workingNow(await addMember("picky", [epsilon.id]));
  expect(body.total).toBe(1);
  expect(body.entries.map((e: Body) => e.item.key)).toEqual([kept]);
});
