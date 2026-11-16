import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { webhookDelivery, webhookSubscription } from "../db/schema.js";
import { createBot } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";
import { type Body, mcpClients } from "./test-client.js";

const { app, db, bot } = setupTestApp();
const { connect, call, callError } = mcpClients(app);

/** A bot that owns one product of its own, with an MCP client. */
async function productBot(name: string) {
  const made = createBot(db, name);
  const client = await connect(made.key);
  const product = await call(client, "create_product", {
    key: projectKey(),
    name: `${name}'s product`,
  });
  return { ...made, client, product };
}

let slugs = 0;
const freshSlug = () => `proj-${++slugs}`;

test("create_project defaults to the caller's one product and to the caller as lead, and derives the slug from the name", async () => {
  const tara = await productBot("Tara");
  const project = await call(tara.client, "create_project", {
    name: "Launch Q4!",
    goal: "ship it",
    targetDate: "2026-12-01",
  });
  expect(project).toEqual({
    id: expect.any(String),
    slug: "launch-q4",
    name: "Launch Q4!",
    goal: "ship it",
    lead: { id: tara.actor.id, name: "Tara", kind: "bot" },
    targetDate: "2026-12-01",
    products: [{ key: tara.product.key, name: "Tara's product" }],
    hiddenProducts: false,
    counts: { triage: 0, open: 0, in_progress: 0, done: 0, canceled: 0 },
    latestStatusUpdate: null,
    createdBy: tara.actor.id,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });
  const again = await call(tara.client, "create_project", {
    name: "launch q4",
  });
  expect(again.slug).toBe("launch-q4-2");
  expect(
    await callError(tara.client, "create_project", {
      name: "taken",
      slug: "Launch-Q4",
    }),
  ).toBe(
    "conflict: slug launch-q4 is taken by another project: choose another slug, or leave slug out to derive a free one from the name",
  );
  expect(
    await callError(tara.client, "create_project", {
      name: "bad",
      slug: "-x",
    }),
  ).toMatch(/^validation_failed: slug must be 2 to 39 lowercase letters/);
});

test("create_project takes a lead by name and several products, and refuses a product the key can't reach as missing", async () => {
  const kai = await productBot("Kai");
  const nia = await productBot("Nia");
  const project = await call(kai.client, "create_project", {
    name: "Cross",
    slug: freshSlug(),
    lead: "NIA",
    products: [kai.product.key, nia.product.key.toLowerCase()],
  });
  expect(project.lead.name).toBe("Nia");
  expect(project.products.map((p: Body) => p.key)).toEqual(
    [kai.product.key, nia.product.key].sort(),
  );

  const scoped = await connect(
    createBot(db, "Kai scoped", { scope: { projects: [kai.product.key] } }).key,
  );
  expect(
    await callError(scoped, "create_project", {
      name: "reach",
      products: [kai.product.key, nia.product.key],
    }),
  ).toBe(
    `not_found: no product ${nia.product.key}: pass the key (like TRL) of a product this key reaches; list_products (GET /api/v1/products) lists them`,
  );
  expect(
    await callError(scoped, "create_project", { name: "none of mine" }),
  ).toBe(
    `validation_failed: you own no product, so create_project needs product: pick one of ${kai.product.key} (list_products describes each)`,
  );
  expect(
    await callError(kai.client, "create_project", {
      name: "led by a stranger",
      lead: "nobody",
    }),
  ).toBe(
    "validation_failed: lead names no bot nobody: pass a bot's name or id (list_bots lists them, and whoami gives your own)",
  );
});

test("update_project changes name, goal, lead and target date; a key reaching none of its products can't", async () => {
  const quinn = await productBot("Quinn");
  const slug = freshSlug();
  await call(quinn.client, "create_project", { name: "before", slug });
  const updated = await call(quinn.client, "update_project", {
    project: slug,
    name: "after",
    goal: "a goal",
    targetDate: "2027-01-31",
    lead: bot.actor.id,
  });
  expect(updated).toMatchObject({
    slug,
    name: "after",
    goal: "a goal",
    targetDate: "2027-01-31",
    lead: { id: bot.actor.id, name: "tester" },
  });
  expect(
    (
      await call(quinn.client, "update_project", {
        project: slug,
        targetDate: null,
      })
    ).targetDate,
  ).toBeNull();
  expect(
    await callError(quinn.client, "update_project", {
      project: slug,
      targetDate: "2027-02-30",
    }),
  ).toMatch(/^validation_failed: targetDate must be a calendar day/);
  const outsider = await productBot("Holly");
  const scoped = await connect(
    createBot(db, "Holly scoped", {
      scope: { projects: [outsider.product.key] },
    }).key,
  );
  expect(
    await callError(scoped, "update_project", { project: slug, name: "x" }),
  ).toBe(
    `not_found: no project ${slug}: pass the slug (like launch-q4) of a project this key reaches; list_projects (GET /api/v1/projects) lists them`,
  );
});

test("add_to_project adds items from two products, adding the second product itself, and a repeat changes nothing", async () => {
  const wren = await productBot("Wren");
  const nora = await productBot("Nora");
  const slug = freshSlug();
  await call(wren.client, "create_project", { name: "together", slug });
  const mine = await call(wren.client, "add_todo", { title: "mine" });
  const theirs = await call(nora.client, "add_todo", { title: "theirs" });

  const added = await call(wren.client, "add_to_project", {
    project: slug,
    items: [mine.key, theirs.key],
  });
  expect(added.added).toEqual([mine.key, theirs.key]);
  expect(added.unchanged).toEqual([]);
  expect(added.project.products.map((p: Body) => p.key)).toEqual(
    [wren.product.key, nora.product.key].sort(),
  );
  expect(added.project.counts.open).toBe(2);

  const repeat = await call(wren.client, "add_to_project", {
    project: slug,
    items: [theirs.key.toLowerCase()],
  });
  expect(repeat).toMatchObject({ added: [], unchanged: [theirs.key] });
  expect(
    (await call(wren.client, "get_item", { item: theirs.key })).projects,
  ).toEqual([{ slug, name: "together" }]);
  expect(
    (
      await call(wren.client, "list_items", {
        project: slug,
        type: "todo",
        status: "open",
      })
    ).items.map((i: Body) => i.key),
  ).toEqual([theirs.key, mine.key]);

  const removed = await call(wren.client, "remove_from_project", {
    project: slug,
    items: [mine.key, mine.key],
  });
  expect(removed).toMatchObject({ removed: [mine.key], unchanged: [] });
  expect(removed.project.products).toHaveLength(2);
  expect(
    await call(wren.client, "remove_from_project", {
      project: slug,
      items: [mine.key],
    }),
  ).toMatchObject({ removed: [], unchanged: [mine.key] });
});

test("add_to_project takes at most 100 items and refuses an item the key can't see as missing", async () => {
  const rhea = await productBot("Rhea");
  const slug = freshSlug();
  await call(rhea.client, "create_project", { name: "limits", slug });
  const items = Array.from(
    { length: 101 },
    (_, i) => `${rhea.product.key}-${i + 1}`,
  );
  expect(
    await callError(rhea.client, "add_to_project", { project: slug, items }),
  ).toMatch(/^MCP error -32602: Input validation error: .*items/s);
  const hidden = await productBot("Faye");
  const secret = await call(hidden.client, "add_todo", { title: "secret" });
  const scoped = await connect(
    createBot(db, "Rhea scoped", { scope: { projects: [rhea.product.key] } })
      .key,
  );
  expect(
    await callError(scoped, "add_to_project", {
      project: slug,
      items: [secret.key],
    }),
  ).toMatch(new RegExp(`^not_found: no item ${secret.key}: `));
});

test("a key scoped to one product sees a cross-product project without any trace of the other product", async () => {
  const remy = await productBot("Remy");
  const juno = await productBot("Juno");
  const slug = freshSlug();
  await call(remy.client, "create_project", {
    name: "shared",
    slug,
    products: [remy.product.key, juno.product.key],
  });
  const visible = await call(remy.client, "add_todo", { title: "visible" });
  const hiddenItems = [
    await call(juno.client, "add_todo", { title: "hidden one" }),
    await call(juno.client, "add_todo", { title: "hidden two" }),
  ];
  await call(remy.client, "add_to_project", {
    project: slug,
    items: [visible.key, ...hiddenItems.map((i) => i.key)],
  });
  await call(juno.client, "post_status_update", {
    project: slug,
    body: "all on track",
    health: "on_track",
  });

  const scoped = await connect(
    createBot(db, "Remy scoped", { scope: { projects: [remy.product.key] } })
      .key,
  );
  const seen: Body[] = [
    await call(scoped, "get_project", { project: slug }),
    await call(scoped, "list_projects", { limit: 200 }),
    await call(scoped, "list_items", { project: slug }),
    await call(scoped, "list_activity", { project: slug, limit: 200 }),
    await call(scoped, "list_activity", { limit: 200 }),
    await call(scoped, "list_status_updates", { project: slug }),
    await call(scoped, "get_item", { item: visible.key }),
  ];
  const project = seen[0] as Body;
  expect(project.products).toEqual([
    { key: remy.product.key, name: "Remy's product" },
  ]);
  expect(project.hiddenProducts).toBe(true);
  expect(project.counts).toEqual({
    triage: 0,
    open: 1,
    in_progress: 0,
    done: 0,
    canceled: 0,
  });
  expect((seen[2] as Body).items.map((i: Body) => i.key)).toEqual([
    visible.key,
  ]);
  expect(
    (seen[3] as Body).items.map((e: Body) => [e.action, e.projectSlug]),
  ).toEqual([
    ["status_update.created", slug],
    ["project.item_added", slug],
    ["project.created", slug],
  ]);
  const text = JSON.stringify(seen);
  for (const trace of [
    juno.product.key,
    juno.product.id,
    "Juno's product",
    ...hiddenItems.flatMap((i) => [i.key, i.id]),
  ]) {
    expect(text, trace).not.toContain(trace);
  }

  const wide = await call(remy.client, "get_project", { project: slug });
  expect(wide).toMatchObject({ hiddenProducts: false });
  expect(wide.counts.open).toBe(3);
});

test("a project drawing only from products the key can't reach is the 404 an unknown slug is", async () => {
  const lena = await productBot("Lena");
  const slug = freshSlug();
  await call(lena.client, "create_project", { name: "private", slug });
  const outsider = await productBot("Vera");
  const scoped = await connect(
    createBot(db, "Vera scoped", {
      scope: { projects: [outsider.product.key] },
    }).key,
  );
  const hidden = await callError(scoped, "get_project", { project: slug });
  const unknown = await callError(scoped, "get_project", {
    project: "no-such-project",
  });
  expect(hidden).toBe(unknown?.replace("no-such-project", slug));
  expect(
    (await call(scoped, "list_projects", { limit: 200 })).items.map(
      (p: Body) => p.slug,
    ),
  ).not.toContain(slug);
});

test("post_status_update and list_status_updates take exactly one of product and project", async () => {
  const pia = await productBot("Pia");
  const slug = freshSlug();
  await call(pia.client, "create_project", { name: "updates", slug });
  const onProject = await call(pia.client, "post_status_update", {
    project: slug,
    body: "halfway",
    health: "at_risk",
  });
  expect(onProject).toMatchObject({
    product: null,
    project: slug,
    projectId: null,
    health: "at_risk",
    authorId: pia.actor.id,
  });
  const onProduct = await call(pia.client, "post_status_update", {
    product: pia.product.key,
    body: "steady",
    health: "on_track",
  });
  expect(onProduct).toMatchObject({ product: pia.product.key, project: null });
  expect(
    (await call(pia.client, "list_status_updates", { project: slug })).items,
  ).toEqual([onProject]);
  expect(
    (await call(pia.client, "get_project", { project: slug }))
      .latestStatusUpdate,
  ).toEqual({
    ...onProject,
    author: { id: pia.actor.id, name: "Pia", kind: "bot" },
  });
  const one =
    "takes exactly one of product (a key like TRL) and project (a slug like launch-q4)";
  expect(
    await callError(pia.client, "post_status_update", {
      product: pia.product.key,
      project: slug,
      body: "x",
      health: "on_track",
    }),
  ).toBe(`validation_failed: post_status_update ${one}: send only one of them`);
  expect(await callError(pia.client, "list_status_updates", {})).toBe(
    `validation_failed: list_status_updates ${one}: send one of them`,
  );
  expect(
    await callError(pia.client, "post_status_update", {
      project: slug,
      body: "x",
      health: "on_track",
      externalRef: "u-1",
    }),
  ).toMatch(
    /^validation_failed: externalRef is kept on a product's status update only/,
  );
});

test("project writes record project.created, project.updated and item_added and item_removed with the project's slug", async () => {
  const skye = await productBot("Skye");
  const slug = freshSlug();
  await call(skye.client, "create_project", { name: "events", slug });
  const todo = await call(skye.client, "add_todo", { title: "evented" });
  await call(skye.client, "update_project", { project: slug, goal: "g" });
  await call(skye.client, "add_to_project", {
    project: slug,
    items: [todo.key],
  });
  await call(skye.client, "remove_from_project", {
    project: slug,
    items: [todo.key],
  });
  const events = (
    await call(skye.client, "list_activity", { project: slug, limit: 200 })
  ).items as Body[];
  expect(
    events.map((e) => [e.action, e.subjectType, e.product, e.projectSlug]),
  ).toEqual([
    ["project.item_removed", "issue", skye.product.key, slug],
    ["project.item_added", "issue", skye.product.key, slug],
    ["project.updated", "project", null, slug],
    ["project.created", "project", null, slug],
  ]);
  expect(events[0]?.payload).toEqual({ project: slug, key: todo.key });
  expect(events[2]?.payload).toEqual({ goal: { from: "", to: "g" } });
});

test("a project's own events reach webhooks following any of its products; an item's events reach its product's followers", async () => {
  const ivy = await productBot("Ivy hooks");
  const kai = await productBot("Kai hooks");
  const follow = async (who: typeof ivy, url: string) =>
    (
      await call(who.client, "create_webhook", {
        url,
        secret: "whsec_projects_0123456789",
        products: [who.product.key],
      })
    ).id as string;
  const ivyHook = await follow(ivy, "https://ivy.example.com/hook");
  const kaiHook = await follow(kai, "https://kai.example.com/hook");
  const slug = freshSlug();
  await call(ivy.client, "create_project", {
    name: "hooked",
    slug,
    products: [ivy.product.key, kai.product.key],
  });
  const todo = await call(ivy.client, "add_todo", { title: "hooked item" });
  await call(ivy.client, "add_to_project", {
    project: slug,
    items: [todo.key],
  });

  const typesFor = (subscriptionId: string) =>
    db
      .select({ type: webhookDelivery.type })
      .from(webhookDelivery)
      .where(eq(webhookDelivery.subscriptionId, subscriptionId))
      .orderBy(webhookDelivery.seq)
      .all()
      .map((d) => d.type);
  expect(typesFor(ivyHook)).toEqual([
    "trail.project.created",
    "trail.issue.created",
    "trail.project.item_added",
  ]);
  expect(typesFor(kaiHook)).toEqual(["trail.project.created"]);
  db.delete(webhookSubscription).run();
});

test("a retried create_project with the same idempotency_key returns the first project", async () => {
  const nia = await productBot("Nia retries");
  const args = { name: "Once only", idempotency_key: "project-once" };
  const first = await call(nia.client, "create_project", args);
  expect(await call(nia.client, "create_project", args)).toEqual(first);
  expect(
    (await call(nia.client, "list_projects", { limit: 200 })).items.filter(
      (p: Body) => p.name === "Once only",
    ),
  ).toHaveLength(1);
});
