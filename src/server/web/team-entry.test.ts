import { expect, test } from "vitest";
import { activityEvent } from "../db/schema.js";
import { setupTestApp } from "../test-app.js";

const { db, bot, request, signIn, owner, addProject } = setupTestApp();

/** A product.created event on `productId` with this payload, as trail or an older build wrote it. */
const created = (productId: string, payload: Record<string, unknown>) =>
  db
    .insert(activityEvent)
    .values({
      actorId: bot.actor.id,
      subjectType: "product",
      subjectId: productId,
      productId,
      action: "product.created",
      payload,
    })
    .returning()
    .get();

test("a product.created event whose payload has kind team is a team_created entry; a product's, and one with no kind, stay product_created", async () => {
  const team = addProject("Ledger");
  const plain = addProject("Plainly");
  const legacy = addProject("Olden");
  const teamEvent = created(team.id, { key: team.key, kind: "team" });
  const plainEvent = created(plain.id, { key: plain.key, kind: "product" });
  const legacyEvent = created(legacy.id, { key: legacy.key });

  const res = await request("GET", "/api/web/feed?limit=200", {
    key: null,
    cookie: await signIn(owner),
  });
  expect(res.status).toBe(200);
  const { items } = (await res.json()) as {
    items: { id: string; kind: string; product: unknown }[];
  };
  const entryOf = (id: string) => items.find((e) => e.id === id);
  expect(entryOf(teamEvent.id)).toMatchObject({
    kind: "team_created",
    product: { key: team.key, name: "Ledger" },
    project: null,
    item: null,
  });
  expect(entryOf(plainEvent.id)).toMatchObject({
    kind: "product_created",
    product: { key: plain.key, name: "Plainly" },
  });
  expect(entryOf(legacyEvent.id)).toMatchObject({
    kind: "product_created",
    product: { key: legacy.key, name: "Olden" },
  });
});
