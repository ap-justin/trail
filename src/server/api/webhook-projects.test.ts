import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
import { webhookDelivery, webhookSubscription } from "../db/schema.js";
import { createBot, createKey, editKeyScope } from "../service/keys.js";
import { setupTestApp, testWebhookSettings } from "../test-app.js";
import { createWebhookWorker, LEFT_PROJECT } from "../webhooks/worker.js";

const sent: { url: string; body: Body }[] = [];
// the worker's clock runs with the real one and jumps ahead by `skew`, so a retry is due by advancing it
let skew = 0;
let receiverDown = false;
const RETRY_AFTER_MS = 60_000;
const { db, bus, request } = setupTestApp();
const worker = createWebhookWorker({
  db,
  bus,
  backoffMs: [RETRY_AFTER_MS],
  settings: testWebhookSettings({
    now: () => Date.now() + skew,
    transport: async ({ url, body }) => {
      sent.push({ url: url.href, body: JSON.parse(body) });
      return { status: receiverDown ? 503 : 204 };
    },
  }),
});

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

async function call(method: string, path: string, key?: string, json?: Body) {
  const res = await request(method, `/api/v1${path}`, { json, key });
  return { status: res.status, body: (await res.json()) as Body };
}
async function ok(method: string, path: string, json?: Body) {
  const res = await call(method, path, undefined, json);
  expect(
    res.status,
    `${method} ${path}: ${JSON.stringify(res.body)}`,
  ).toBeLessThan(300);
  return res.body;
}

const SECRET = "whsec_project_follow_0123456789";
let urls = 0;
const hook = (json: Body, key?: string) =>
  call("POST", "/webhooks", key, {
    url: `https://bot.example.com/hooks/${++urls}`,
    secret: SECRET,
    ...json,
  });
/** A webhook that must be created, with its URL. */
async function follow(json: Body, key?: string) {
  const made = await hook(json, key);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body as { id: string; url: string };
}

/** What the worker sends `url` from here on, as "type subject", `twins` choosing the trail.item.* copies or everything else. */
async function sentTo(url: string, twins: boolean) {
  await worker.tick();
  return sent
    .filter(
      (s) => s.url === url && s.body.type.startsWith("trail.item.") === twins,
    )
    .map((s) => `${s.body.type} ${s.body.data.subject.key}`);
}
const receivedBy = (url: string) => sentTo(url, false);
/** The trail.item.* copies of the item events, which a follow must treat as it treats the originals. */
const twinsOf = (url: string) => sentTo(url, true);

// products ATL and BTA; project recon draws from both, and each keeps items outside it
await ok("POST", "/products", { key: "ATL", name: "Alpha product" });
await ok("POST", "/products", { key: "BTA", name: "Beta product" });
await ok("POST", "/products", { key: "CTX", name: "Product in no project" });
const todo = async (product: string, title: string) =>
  (await ok("POST", "/items", { type: "todo", product, title })).key as string;
const atlIn = await todo("ATL", "atl in recon");
const btaIn = await todo("BTA", "bta in recon");
const btaOut = await todo("BTA", "bta outside");
await ok("POST", "/projects", {
  name: "Recon",
  slug: "recon",
  products: ["ATL", "BTA"],
});
await ok("POST", "/projects", {
  name: "Other",
  slug: "other",
  products: ["ATL"],
});
await ok("POST", "/projects/recon/items", { items: [atlIn, btaIn] });

const reconOnly = createBot(db, "recon-only", {
  scope: { projects: ["recon"], actions: ["read", "issues", "comments"] },
}).key;

/** A new item of `product`, in recon when `inRecon`. */
async function item(product: string, inRecon: boolean) {
  const key = await todo(product, `${product} item`);
  if (inRecon) await ok("POST", "/projects/recon/items", { items: [key] });
  return key;
}
const retitle = (key: string, title: string) =>
  ok("PATCH", `/items/${key}`, { title });

beforeEach(async () => {
  // what earlier tests queued goes out first, so no test reads another's deliveries
  await worker.tick();
  db.delete(webhookSubscription).run();
  sent.length = 0;
  receiverDown = false;
});

test("a project-only key follows its project with projects, and its view lists the slug beside an empty products", async () => {
  const made = await hook({ projects: ["recon"] }, reconOnly);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect(made.body).toMatchObject({
    kind: "activity",
    products: [],
    projects: ["recon"],
  });
  expect(made.body).not.toHaveProperty("deprecated");
});

test("a key reaching exactly one project and no product follows it when neither products nor projects is sent", async () => {
  const made = await hook({}, reconOnly);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  expect(made.body).toMatchObject({ products: [], projects: ["recon"] });
});

test("a project the key doesn't reach is the 404 a missing one is", async () => {
  const hidden = await hook({ projects: ["other"] }, reconOnly);
  const missing = await hook({ projects: ["nowhere"] }, reconOnly);
  expect(hidden.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(hidden.body.error.message).toBe(
    missing.body.error.message.replace("nowhere", "other"),
  );
});

test("a product the key only names through its project is refused, pointing to the project", async () => {
  const refused = await hook({ products: ["BTA"] }, reconOnly);
  expect(refused.status).toBe(404);
  expect(refused.body.error.message).toBe(
    'this key reaches product BTA only through project recon: send projects: ["recon"] in place of BTA, for the events of the project\'s items; the rest of BTA needs a key that lists BTA',
  );
});

test("projects takes slugs and, as the deprecated alias of products, product keys, value by value; a slug in products is a 422", async () => {
  const mixed = await hook({ projects: ["ATL", "recon"] });
  expect(mixed.status).toBe(201);
  expect(mixed.body).toMatchObject({
    products: ["ATL"],
    projects: ["recon"],
    deprecated:
      "projects is deprecated: send products with the products' keys (like TRL)",
  });
  // a product key alone keeps the old call's meaning: the project follows stay
  const aliased = await call("PATCH", `/webhooks/${mixed.body.id}`, undefined, {
    projects: ["BTA"],
  });
  expect(aliased.body).toMatchObject({
    products: ["BTA"],
    projects: ["recon"],
  });
  const slugOnly = await hook({ projects: ["recon"] });
  expect(slugOnly.body).not.toHaveProperty("deprecated");

  const neither = await hook({ projects: ["nowhere"] });
  expect(neither.status).toBe(404);
  expect(neither.body.error.message).toContain("nowhere");
  const slug = await hook({ products: ["recon"] });
  expect(slug.status).toBe(422);
  expect(slug.body.error.message).toBe(
    'products takes product keys and recon is a project\'s slug: send it in projects (projects: ["recon"])',
  );
});

test("a product key in projects matches in any case, as the alias did before projects", async () => {
  const lower = await hook({ projects: ["atl"] });
  expect(lower.status, JSON.stringify(lower.body)).toBe(201);
  expect(lower.body).toMatchObject({ products: ["ATL"], projects: [] });
});

test("a product key in projects that the key only names through its project gets the advice products gets", async () => {
  const refused = await hook({ projects: ["BTA"] }, reconOnly);
  expect(refused.status).toBe(404);
  expect(refused.body.error.message).toBe(
    (await hook({ products: ["BTA"] }, reconOnly)).body.error.message,
  );
});

test("an event on an item in the project is delivered; one on an item of the same product outside it is not", async () => {
  const { url } = await follow({ projects: ["recon"] }, reconOnly);
  await retitle(btaIn, "bta in recon, renamed");
  await ok("POST", `/items/${btaIn}/comments`, { body: "seen" });
  await retitle(btaOut, "bta outside, renamed");
  await ok("POST", `/items/${btaOut}/comments`, { body: "unseen" });
  expect(await receivedBy(url)).toEqual([
    `trail.issue.updated ${btaIn}`,
    `trail.comment.created ${btaIn}`,
  ]);
  expect(await twinsOf(url)).toEqual([`trail.item.updated ${btaIn}`]);
});

test("the project's own events are delivered: its updates, status updates and items joining it", async () => {
  const { url } = await follow({ projects: ["recon"] }, reconOnly);
  await ok("PATCH", "/projects/recon", { goal: "map the ground" });
  await ok("POST", "/projects/recon/status-updates", {
    body: "on track",
    health: "on_track",
  });
  const joined = await item("BTA", true);
  // its create came before it joined, so it is not among them
  expect(await receivedBy(url)).toEqual([
    "trail.project.updated recon",
    "trail.status_update.created recon",
    `trail.project.item_added ${joined}`,
  ]);
});

test("an item leaving the project stops its events: the removal is delivered, later events are not", async () => {
  const leaving = await item("BTA", true);
  const { url } = await follow({ projects: ["recon"] }, reconOnly);
  await ok("DELETE", `/projects/recon/items/${leaving}`);
  await retitle(leaving, "gone from recon");
  await ok("POST", `/items/${leaving}/comments`, { body: "after" });
  expect(await receivedBy(url)).toEqual([
    `trail.project.item_removed ${leaving}`,
  ]);
  expect(await twinsOf(url)).toEqual([]);
});

test("an event queued while the item was in the project is dropped at send once it has left, and shows as failed with the reason", async () => {
  const leaving = await item("ATL", true);
  const { id, url } = await follow({ projects: ["recon"] }, reconOnly);
  await retitle(leaving, "queued in recon");
  await ok("DELETE", `/projects/recon/items/${leaving}`);
  expect(await receivedBy(url)).toEqual([
    `trail.project.item_removed ${leaving}`,
  ]);
  const history = db
    .select()
    .from(webhookDelivery)
    .where(eq(webhookDelivery.subscriptionId, id))
    .orderBy(webhookDelivery.seq)
    .all()
    .map((d) => [d.type, d.status, d.attempts, d.lastError]);
  expect(history).toEqual([
    ["trail.issue.updated", "failed", 0, LEFT_PROJECT],
    ["trail.item.updated", "failed", 0, LEFT_PROJECT],
    ["trail.project.item_removed", "delivered", 1, null],
  ]);
  // a drop is not the receiver's failure: the webhook stays healthy
  expect((await call("GET", `/webhooks/${id}`, reconOnly)).body).toMatchObject({
    consecutiveFailures: 0,
    lastError: null,
    paused: false,
  });
});

/** A subscription's deliveries in queue order, as [type, status, attempts, lastError]. */
const historyOf = (subscriptionId: string) =>
  db
    .select()
    .from(webhookDelivery)
    .where(eq(webhookDelivery.subscriptionId, subscriptionId))
    .orderBy(webhookDelivery.seq)
    .all()
    .map((d) => [d.type, d.status, d.attempts, d.lastError]);

test("a comment queued while the item was in the project is dropped at send once the item has left", async () => {
  const leaving = await item("ATL", true);
  const { id, url } = await follow({ projects: ["recon"] }, reconOnly);
  await ok("POST", `/items/${leaving}/comments`, { body: "queued in recon" });
  await ok("DELETE", `/projects/recon/items/${leaving}`);
  expect(await receivedBy(url)).toEqual([
    `trail.project.item_removed ${leaving}`,
  ]);
  expect(historyOf(id)).toEqual([
    ["trail.comment.created", "failed", 0, LEFT_PROJECT],
    ["trail.project.item_removed", "delivered", 1, null],
  ]);
});

test("an item leaving a project is still delivered to a webhook that follows its product too", async () => {
  const leaving = await item("ATL", true);
  const { id, url } = await follow({ products: ["ATL"], projects: ["recon"] });
  await retitle(leaving, "queued in recon");
  await ok("POST", `/items/${leaving}/comments`, { body: "queued too" });
  await ok("DELETE", `/projects/recon/items/${leaving}`);
  expect(await receivedBy(url)).toEqual([
    `trail.issue.updated ${leaving}`,
    `trail.comment.created ${leaving}`,
    `trail.project.item_removed ${leaving}`,
  ]);
  expect(await twinsOf(url)).toEqual([`trail.item.updated ${leaving}`]);
  expect(historyOf(id).filter((h) => h[1] !== "delivered")).toEqual([]);
});

test("an item moving from one followed project to another keeps its events, each once", async () => {
  const moving = await item("ATL", true);
  const { id, url } = await follow({ projects: ["other", "recon"] });
  await retitle(moving, "queued in recon");
  await ok("POST", "/projects/other/items", { items: [moving] });
  await ok("DELETE", `/projects/recon/items/${moving}`);
  await retitle(moving, "after the move");
  expect(await receivedBy(url)).toEqual([
    `trail.issue.updated ${moving}`,
    `trail.project.item_added ${moving}`,
    `trail.project.item_removed ${moving}`,
    `trail.issue.updated ${moving}`,
  ]);
  expect(historyOf(id).filter((h) => h[1] !== "delivered")).toEqual([]);
});

test("a delivery that failed once and is waiting to retry is dropped when its item has left the project meanwhile", async () => {
  const leaving = await item("ATL", true);
  const { id, url } = await follow({ projects: ["recon"] }, reconOnly);
  receiverDown = true;
  await retitle(leaving, "queued in recon");
  await worker.tick();
  expect(historyOf(id)[0]).toEqual([
    "trail.issue.updated",
    "pending",
    1,
    expect.any(String),
  ]);
  await ok("DELETE", `/projects/recon/items/${leaving}`);
  receiverDown = false;
  skew += RETRY_AFTER_MS;
  expect(await receivedBy(url)).toEqual([
    `trail.issue.updated ${leaving}`, // the failed first attempt
    `trail.project.item_removed ${leaving}`,
  ]);
  expect(historyOf(id)).toEqual([
    ["trail.issue.updated", "failed", 1, LEFT_PROJECT],
    ["trail.item.updated", "failed", 0, LEFT_PROJECT],
    ["trail.project.item_removed", "delivered", 1, null],
  ]);
});

test("an item joining the project starts its events", async () => {
  const joining = await item("BTA", false);
  const { url } = await follow({ projects: ["recon"] }, reconOnly);
  await retitle(joining, "before joining");
  await ok("POST", "/projects/recon/items", { items: [joining] });
  await retitle(joining, "after joining");
  expect(await receivedBy(url)).toEqual([
    `trail.project.item_added ${joining}`,
    `trail.issue.updated ${joining}`,
  ]);
  expect(await twinsOf(url)).toEqual([`trail.item.updated ${joining}`]);
});

test("a webhook following both an item's product and its project gets each event once", async () => {
  const { url } = await follow({ products: ["ATL"], projects: ["recon"] });
  await retitle(atlIn, "atl in recon, once");
  await ok("POST", "/projects/recon/status-updates", {
    body: "still once",
    health: "at_risk",
  });
  expect(await receivedBy(url)).toEqual([
    `trail.issue.updated ${atlIn}`,
    "trail.status_update.created recon",
  ]);
  expect(await twinsOf(url)).toEqual([`trail.item.updated ${atlIn}`]);
});

test("a product-following webhook is unchanged: it gets the product's items in and out of projects, and keeps an event queued before the item left", async () => {
  const leaving = await item("BTA", true);
  const { url } = await follow({ products: ["BTA"] });
  await retitle(btaOut, "outside, for BTA");
  await retitle(leaving, "queued for BTA");
  await ok("DELETE", `/projects/recon/items/${leaving}`);
  await retitle(leaving, "after leaving, for BTA");
  expect(await receivedBy(url)).toEqual([
    `trail.issue.updated ${btaOut}`,
    `trail.issue.updated ${leaving}`,
    `trail.project.item_removed ${leaving}`,
    `trail.issue.updated ${leaving}`,
  ]);
  expect(await twinsOf(url)).toEqual([
    `trail.item.updated ${btaOut}`,
    `trail.item.updated ${leaving}`,
    `trail.item.updated ${leaving}`,
  ]);
});

test("an unrestricted key follows any project, and its product follows stay as they were", async () => {
  const made = await follow({ projects: ["other", "recon"] });
  expect((await call("GET", `/webhooks/${made.id}`)).body).toMatchObject({
    products: [],
    projects: ["other", "recon"],
  });
  const moved = await call("PATCH", `/webhooks/${made.id}`, undefined, {
    products: ["BTA"],
  });
  expect(moved.body).toMatchObject({
    products: ["BTA"],
    projects: ["other", "recon"],
  });
  const emptied = await call("PATCH", `/webhooks/${made.id}`, undefined, {
    products: [],
    projects: [],
  });
  expect(emptied.status).toBe(422);
  expect(emptied.body.error.message).toBe(
    "an activity webhook follows at least one product or project: send products with product keys (like TRL) or projects with project slugs (like launch-q4), or delete the webhook",
  );
});

test("a key that doesn't reach every project a webhook follows can't list, read, change, rotate, ping or delete it", async () => {
  const owner = createBot(db, "two-keyed");
  const wide = await follow({ projects: ["other", "recon"] }, owner.key);
  const reconKey = createKey(db, owner.actor.id, { projects: ["recon"] }).key;
  expect((await call("GET", "/webhooks", reconKey)).body.items).toEqual([]);
  for (const [method, path, json] of [
    ["GET", `/webhooks/${wide.id}`],
    ["PATCH", `/webhooks/${wide.id}`, { projects: ["recon"] }],
    ["PUT", `/webhooks/${wide.id}/secret`, { secret: `${SECRET}-next` }],
    ["POST", `/webhooks/${wide.id}/ping`],
    ["DELETE", `/webhooks/${wide.id}`],
  ] as const) {
    const res = await call(method, path, reconKey, json);
    expect(res.status, `${method} ${path}`).toBe(404);
    expect(res.body.error.message).toBe(
      `no webhook ${wide.id}: list yours with list_webhooks (GET /webhooks)`,
    );
  }

  // the bot's own recon webhook is the recon key's to manage
  const mine = await follow({ projects: ["recon"] }, owner.key);
  expect(
    (await call("GET", "/webhooks", reconKey)).body.items.map(
      (w: Body) => w.id,
    ),
  ).toEqual([mine.id]);
  for (const [method, path, json] of [
    ["GET", `/webhooks/${mine.id}`],
    ["PATCH", `/webhooks/${mine.id}`, { url: "https://bot.example.com/moved" }],
    ["PUT", `/webhooks/${mine.id}/secret`, { secret: `${SECRET}-next` }],
    ["POST", `/webhooks/${mine.id}/ping`],
    ["DELETE", `/webhooks/${mine.id}`],
  ] as const) {
    const res = await call(method, path, reconKey, json);
    expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(
      200,
    );
  }
});

test("adding a project the key doesn't reach on update is the 404 it is on create", async () => {
  const { id } = await follow({}, reconOnly);
  const refused = await call("PATCH", `/webhooks/${id}`, reconOnly, {
    projects: ["recon", "other"],
  });
  expect(refused.status).toBe(404);
  expect(refused.body.error.message).toBe(
    (await hook({ projects: ["other"] }, reconOnly)).body.error.message,
  );
});

test("a scope edit takes a followed project from the key's reach, and the webhook with it, until the project is added back", async () => {
  const owner = createBot(db, "scope-edited");
  const edited = createKey(db, owner.actor.id, {
    projects: ["other", "recon"],
  }).key;
  const wide = await follow({ projects: ["other", "recon"] }, owner.key);
  const prefix = edited.slice(6, 14);
  const status = async () =>
    (await call("GET", `/webhooks/${wide.id}`, edited)).status;
  const listed = async () =>
    (await call("GET", "/webhooks", edited)).body.items.map((w: Body) => w.id);
  expect(await status()).toBe(200);
  expect(await listed()).toEqual([wide.id]);

  editKeyScope(db, prefix, { removeProjects: ["other"] });
  expect(await status()).toBe(404);
  expect(await listed()).toEqual([]);

  editKeyScope(db, prefix, { addProjects: ["other"] });
  expect(await status()).toBe(200);
  expect(await listed()).toEqual([wide.id]);
});

test("a key follows only the projects it lists: one reached through its products is the 404 a missing one is", async () => {
  const btaKey = createBot(db, "bta-reader", {
    scope: { products: ["BTA"], actions: ["read"] },
  }).key;
  const mixedKey = createBot(db, "bta-and-other", {
    scope: { products: ["BTA"], projects: ["other"], actions: ["read"] },
  }).key;
  const missing = await hook({ projects: ["nowhere"] }, btaKey);
  for (const key of [btaKey, mixedKey]) {
    const refused = await hook({ projects: ["recon"] }, key);
    expect(refused.status).toBe(404);
    expect(refused.body.error.message).toBe(
      missing.body.error.message.replace("nowhere", "recon"),
    );
  }
  expect((await hook({ projects: ["other"] }, mixedKey)).status).toBe(201);
});

test("a projects value longer than a slug can be is a 422 before any lookup", async () => {
  const atMost = await hook({ projects: ["a".repeat(39)] });
  expect(atMost.status).toBe(404);
  const over = await hook({ projects: ["a".repeat(40)] });
  expect(over.status).toBe(422);
  expect(JSON.stringify(over.body.error)).toContain("projects");
});

test("the bot's webhook following a project is out of reach of its key that reaches the project only through its products", async () => {
  const owner = createBot(db, "bta-and-recon");
  const { id } = await follow({ projects: ["recon"] }, owner.key);
  const btaKey = createKey(db, owner.actor.id, { products: ["BTA"] }).key;
  expect((await call("GET", `/webhooks/${id}`, owner.key)).status).toBe(200);
  expect((await call("GET", `/webhooks/${id}`, btaKey)).status).toBe(404);
});

test("an update drops the queued events of a project no longer followed and keeps those of one still followed", async () => {
  const { id, url } = await follow({ projects: ["recon"] });
  await ok("POST", "/projects/recon/status-updates", {
    body: "queued for recon",
    health: "on_track",
  });
  await retitle(atlIn, "queued through recon");
  // a product list replaced leaves the project's queued events alone
  await ok("PATCH", `/webhooks/${id}`, { products: ["CTX"] });
  expect(await receivedBy(url)).toEqual([
    "trail.status_update.created recon",
    `trail.issue.updated ${atlIn}`,
  ]);
  expect(await twinsOf(url)).toEqual([`trail.item.updated ${atlIn}`]);

  await ok("POST", "/projects/recon/status-updates", {
    body: "never sent",
    health: "off_track",
  });
  await retitle(atlIn, "never sent either");
  await ok("PATCH", `/webhooks/${id}`, { projects: ["other"] });
  expect(await receivedBy(url)).toEqual([
    "trail.status_update.created recon",
    `trail.issue.updated ${atlIn}`,
  ]);
  expect(await twinsOf(url)).toEqual([`trail.item.updated ${atlIn}`]);
  expect(
    db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.subscriptionId, id))
      .all()
      .filter((d) => d.status !== "delivered"),
  ).toEqual([]);
});
