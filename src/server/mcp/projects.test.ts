import { eq } from "drizzle-orm";
import { expect, onTestFinished, test, vi } from "vitest";
import { webhookDelivery, webhookSubscription } from "../db/schema.js";
import { createBot } from "../service/keys.js";
import { atFakeTimeAsync, projectKey, setupTestApp } from "../test-app.js";
import { type Body, mcpClients } from "./test-client.js";

const { app, db, bot, request } = setupTestApp();
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
  const alpha = await productBot("Alpha");
  const project = await call(alpha.client, "create_project", {
    name: "Launch Q4!",
    goal: "ship it",
    targetDate: "2026-12-01",
  });
  expect(project).toEqual({
    id: expect.any(String),
    slug: "launch-q4",
    name: "Launch Q4!",
    goal: "ship it",
    lead: { id: alpha.actor.id, name: "Alpha", kind: "bot" },
    targetDate: "2026-12-01",
    products: [{ key: alpha.product.key, name: "Alpha's product" }],
    hiddenProducts: false,
    counts: { triage: 0, open: 0, in_progress: 0, done: 0, canceled: 0 },
    notes: { current: 0, archived: 0 },
    latestStatusUpdate: null,
    createdBy: alpha.actor.id,
    createdAt: expect.any(String),
    updatedAt: expect.any(String),
  });
  const again = await call(alpha.client, "create_project", {
    name: "launch q4",
  });
  expect(again.slug).toBe("launch-q4-2");
  expect(
    await callError(alpha.client, "create_project", {
      name: "taken",
      slug: "Launch-Q4",
    }),
  ).toBe(
    "conflict: slug launch-q4 is taken by another project: choose another slug, or leave slug out to derive a free one from the name",
  );
  expect(
    await callError(alpha.client, "create_project", {
      name: "bad",
      slug: "-x",
    }),
  ).toMatch(/^validation_failed: slug must be 2 to 39 lowercase letters/);
});

test("create_project takes a lead by name and several products, and refuses a product the key reads only through a project as missing", async () => {
  const beta = await productBot("Beta");
  const epsilon = await productBot("Epsilon");
  const cross = freshSlug();
  const project = await call(beta.client, "create_project", {
    name: "Cross",
    slug: cross,
    lead: "EPSILON",
    products: [beta.product.key, epsilon.product.key.toLowerCase()],
  });
  expect(project.lead.name).toBe("Epsilon");
  expect(project.products.map((p: Body) => p.key)).toEqual(
    [beta.product.key, epsilon.product.key].sort(),
  );

  const scoped = await connect(
    createBot(db, "Beta scoped", { scope: { products: [beta.product.key] } })
      .key,
  );
  expect(
    await callError(scoped, "create_project", {
      name: "reach",
      products: [beta.product.key, epsilon.product.key],
    }),
  ).toBe(
    `not_found: this key reads product ${epsilon.product.key} only through project ${cross}, which reaches ${cross}'s ${epsilon.product.key} items to read and comment on: anything on ${epsilon.product.key} itself needs a key that lists ${epsilon.product.key}`,
  );
  expect(
    await callError(scoped, "create_project", { name: "none of mine" }),
  ).toBe(
    `validation_failed: you own no product, so create_project needs products: send products with one or more of ${beta.product.key} (list_products describes each)`,
  );
  expect(
    await callError(beta.client, "create_project", {
      name: "led by a stranger",
      lead: "nobody",
    }),
  ).toBe(
    "validation_failed: lead names no bot nobody: pass a bot's name or id (list_bots lists them, and whoami gives your own)",
  );
});

test("update_project changes name, goal, lead and target date; a key reaching none of its products can't", async () => {
  const kappa = await productBot("Kappa");
  const slug = freshSlug();
  await call(kappa.client, "create_project", { name: "before", slug });
  const updated = await call(kappa.client, "update_project", {
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
      await call(kappa.client, "update_project", {
        project: slug,
        targetDate: null,
      })
    ).targetDate,
  ).toBeNull();
  expect(
    await callError(kappa.client, "update_project", {
      project: slug,
      targetDate: "2027-02-30",
    }),
  ).toMatch(/^validation_failed: targetDate must be a calendar day/);
  const outsider = await productBot("Pi");
  const scoped = await connect(
    createBot(db, "Pi scoped", {
      scope: { products: [outsider.product.key] },
    }).key,
  );
  expect(
    await callError(scoped, "update_project", { project: slug, name: "x" }),
  ).toBe(
    `not_found: no project ${slug}: pass the slug (like launch-q4) of a project this key reaches; list_projects (GET /api/v1/projects) lists them`,
  );
});

test("add_to_project adds items from two products, adding the second product itself, and a repeat changes nothing", async () => {
  const sigma = await productBot("Sigma");
  const rho = await productBot("Rho");
  const slug = freshSlug();
  await call(sigma.client, "create_project", { name: "together", slug });
  // one stamp apiece: list_items orders newest first, and same-millisecond rows sort by random id
  const [mine, theirs] = await atFakeTimeAsync([
    () => call(sigma.client, "add_todo", { title: "mine" }),
    () => call(rho.client, "add_todo", { title: "theirs" }),
  ]);
  if (!mine || !theirs) throw new Error("add_todo answered nothing");

  const added = await call(sigma.client, "add_to_project", {
    project: slug,
    items: [mine.key, theirs.key],
  });
  expect(added.added).toEqual([mine.key, theirs.key]);
  expect(added.unchanged).toEqual([]);
  expect(added.project.products.map((p: Body) => p.key)).toEqual(
    [sigma.product.key, rho.product.key].sort(),
  );
  expect(added.project.counts.open).toBe(2);

  const repeat = await call(sigma.client, "add_to_project", {
    project: slug,
    items: [theirs.key.toLowerCase()],
  });
  expect(repeat).toMatchObject({ added: [], unchanged: [theirs.key] });
  expect(
    (await call(sigma.client, "get_item", { item: theirs.key })).projects,
  ).toEqual([{ slug, name: "together" }]);
  expect(
    (
      await call(sigma.client, "list_items", {
        project: slug,
        type: "todo",
        status: "open",
      })
    ).items.map((i: Body) => i.key),
  ).toEqual([theirs.key, mine.key]);

  const removed = await call(sigma.client, "remove_from_project", {
    project: slug,
    items: [mine.key, mine.key],
  });
  expect(removed).toMatchObject({ removed: [mine.key], unchanged: [] });
  expect(removed.project.products).toHaveLength(2);
  expect(
    await call(sigma.client, "remove_from_project", {
      project: slug,
      items: [mine.key],
    }),
  ).toMatchObject({ removed: [], unchanged: [mine.key] });
});

test("add_to_project takes at most 100 items and refuses an item the key can't see as missing", async () => {
  const mu = await productBot("Mu");
  const slug = freshSlug();
  await call(mu.client, "create_project", { name: "limits", slug });
  const items = Array.from(
    { length: 101 },
    (_, i) => `${mu.product.key}-${i + 1}`,
  );
  expect(
    await callError(mu.client, "add_to_project", { project: slug, items }),
  ).toMatch(/^MCP error -32602: Input validation error: .*items/s);
  const hidden = await productBot("Omicron");
  const secret = await call(hidden.client, "add_todo", { title: "secret" });
  const scoped = await connect(
    createBot(db, "Mu scoped", { scope: { products: [mu.product.key] } }).key,
  );
  expect(
    await callError(scoped, "add_to_project", {
      project: slug,
      items: [secret.key],
    }),
  ).toMatch(new RegExp(`^not_found: no item ${secret.key}: `));
});

test("a key scoped to one product reads a cross-product project's items of the other product, and that product by name only", async () => {
  const lambda = await productBot("Lambda");
  const eta = await productBot("Eta");
  const slug = freshSlug();
  await call(lambda.client, "create_project", {
    name: "shared",
    slug,
    products: [lambda.product.key, eta.product.key],
  });
  const visible = await call(lambda.client, "add_todo", { title: "visible" });
  const etaItems = [
    await call(eta.client, "add_todo", { title: "eta one" }),
    await call(eta.client, "add_todo", { title: "eta two" }),
  ];
  const etaOutside = await call(eta.client, "add_todo", { title: "outside" });
  await call(lambda.client, "add_to_project", {
    project: slug,
    items: [visible.key, ...etaItems.map((i) => i.key)],
  });

  const scoped = await connect(
    createBot(db, "Lambda scoped", {
      scope: { products: [lambda.product.key] },
    }).key,
  );
  const project = await call(scoped, "get_project", { project: slug });
  expect(project.products).toEqual(
    [
      { key: lambda.product.key, name: "Lambda's product" },
      { key: eta.product.key, name: "Eta's product" },
    ].sort((a, b) => a.key.localeCompare(b.key)),
  );
  expect(project.hiddenProducts).toBe(false);
  expect(project.counts).toEqual(
    (await call(lambda.client, "get_project", { project: slug })).counts,
  );
  expect(
    (await call(scoped, "list_items", { project: slug })).items
      .map((i: Body) => i.key)
      .sort(),
  ).toEqual([visible.key, ...etaItems.map((i) => i.key)].sort());
  expect(
    (await call(scoped, "get_item", { item: etaItems[0]?.key })).access,
  ).toBe("via_project");
  expect(
    await callError(scoped, "get_item", { item: etaOutside.key }),
  ).toContain(`no item ${etaOutside.key}`);
  expect(
    await call(scoped, "get_product", { product: eta.product.key }),
  ).toEqual({
    id: eta.product.id,
    key: eta.product.key,
    name: "Eta's product",
  });
});

test("a project drawing only from products the key can't reach is the 404 an unknown slug is", async () => {
  const theta = await productBot("Theta");
  const slug = freshSlug();
  await call(theta.client, "create_project", { name: "private", slug });
  const outsider = await productBot("Xi");
  const scoped = await connect(
    createBot(db, "Xi scoped", {
      scope: { products: [outsider.product.key] },
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
  const iota = await productBot("Iota");
  const slug = freshSlug();
  await call(iota.client, "create_project", { name: "updates", slug });
  const onProject = await call(iota.client, "post_status_update", {
    project: slug,
    body: "halfway",
    health: "at_risk",
  });
  expect(onProject).toMatchObject({
    product: null,
    project: slug,
    projectId: null,
    health: "at_risk",
    authorId: iota.actor.id,
  });
  const onProduct = await call(iota.client, "post_status_update", {
    product: iota.product.key,
    body: "steady",
    health: "on_track",
  });
  expect(onProduct).toMatchObject({ product: iota.product.key, project: null });
  expect(
    (await call(iota.client, "list_status_updates", { project: slug })).items,
  ).toEqual([onProject]);
  expect(
    (await call(iota.client, "get_project", { project: slug }))
      .latestStatusUpdate,
  ).toEqual({
    ...onProject,
    author: { id: iota.actor.id, name: "Iota", kind: "bot" },
  });
  const one =
    "takes exactly one of product (a key like TRL) and project (a slug like launch-q4)";
  expect(
    await callError(iota.client, "post_status_update", {
      product: iota.product.key,
      project: slug,
      body: "x",
      health: "on_track",
    }),
  ).toBe(`validation_failed: post_status_update ${one}: send only one of them`);
  expect(await callError(iota.client, "list_status_updates", {})).toBe(
    `validation_failed: list_status_updates ${one}: send one of them`,
  );
  expect(
    await callError(iota.client, "post_status_update", {
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
  const nu = await productBot("Nu");
  const slug = freshSlug();
  await call(nu.client, "create_project", { name: "events", slug });
  const todo = await call(nu.client, "add_todo", { title: "evented" });
  await call(nu.client, "update_project", { project: slug, goal: "g" });
  await call(nu.client, "add_to_project", {
    project: slug,
    items: [todo.key],
  });
  await call(nu.client, "remove_from_project", {
    project: slug,
    items: [todo.key],
  });
  const events = (
    await call(nu.client, "list_activity", { project: slug, limit: 200 })
  ).items as Body[];
  expect(
    events.map((e) => [e.action, e.subjectType, e.product, e.projectSlug]),
  ).toEqual([
    ["project.item_removed", "issue", nu.product.key, slug],
    ["project.item_added", "issue", nu.product.key, slug],
    ["project.updated", "project", null, slug],
    ["project.created", "project", null, slug],
  ]);
  expect(events[0]?.payload).toEqual({ project: slug, key: todo.key });
  expect(events[2]?.payload).toEqual({ goal: { from: "", to: "g" } });
});

test("a project's own events reach webhooks following any of its products; an item's events reach its product's followers", async () => {
  onTestFinished(() => {
    db.delete(webhookSubscription).run();
  });
  const zeta = await productBot("Zeta hooks");
  const beta = await productBot("Beta hooks");
  const follow = async (who: typeof zeta, url: string) =>
    (
      await call(who.client, "create_webhook", {
        url,
        secret: "whsec_projects_0123456789",
        products: [who.product.key],
      })
    ).id as string;
  const zetaHook = await follow(zeta, "https://zeta.example.com/hook");
  const betaHook = await follow(beta, "https://beta.example.com/hook");
  const slug = freshSlug();
  await call(zeta.client, "create_project", {
    name: "hooked",
    slug,
    products: [zeta.product.key, beta.product.key],
  });
  const todo = await call(zeta.client, "add_todo", { title: "hooked item" });
  await call(zeta.client, "add_to_project", {
    project: slug,
    items: [todo.key],
  });

  const typesFor = (subscriptionId: string) =>
    db
      .select({ type: webhookDelivery.type })
      .from(webhookDelivery)
      .where(eq(webhookDelivery.subscriptionId, subscriptionId))
      .orderBy(webhookDelivery.seq, webhookDelivery.type)
      .all()
      .map((d) => d.type);
  expect(typesFor(zetaHook)).toEqual([
    "trail.project.created",
    "trail.issue.created",
    "trail.item.created",
    "trail.project.item_added",
  ]);
  expect(typesFor(betaHook)).toEqual(["trail.project.created"]);
});

test("a retried create_project with the same idempotency_key returns the first project", async () => {
  const epsilon = await productBot("Epsilon retries");
  const args = { name: "Once only", idempotency_key: "project-once" };
  const first = await call(epsilon.client, "create_project", args);
  expect(await call(epsilon.client, "create_project", args)).toEqual(first);
  expect(
    (await call(epsilon.client, "list_projects", { limit: 200 })).items.filter(
      (p: Body) => p.name === "Once only",
    ),
  ).toHaveLength(1);
});

test("a product key sent as project to list_items, the status update tools or list_activity is refused with a pointer to product; add_to_project and remove_from_project point to project slugs", async () => {
  const owner = await productBot("Pointed");
  const key = owner.product.key;
  const told = `not_found: no project ${key}: that is a product key, send it as product (product: "${key}")`;
  for (const [tool, args] of [
    ["list_items", { project: key }],
    ["list_items", { project: key.toLowerCase() }],
    ["list_status_updates", { project: key }],
    ["post_status_update", { project: key, body: "b", health: "on_track" }],
    ["list_activity", { project: key }],
  ] as const) {
    const answer = await callError(owner.client, tool, args);
    expect(answer, `${tool} ${JSON.stringify(args)}`).toBe(
      told.replace(`project ${key}:`, `project ${args.project}:`),
    );
  }
  const item = await call(owner.client, "add_todo", { title: "t" });
  for (const [tool, route] of [
    ["add_to_project", "POST /projects/{slug}/items"],
    ["remove_from_project", "DELETE /projects/{slug}/items/{key}"],
  ]) {
    expect(
      await callError(owner.client, tool as string, {
        project: key,
        items: [item.key],
      }),
      tool,
    ).toBe(
      `not_found: no project ${key}: that is a product key, and ${tool} (${route}) takes a project's slug; list_projects (GET /projects) lists them`,
    );
  }
  expect(
    await callError(owner.client, "list_items", { project: "no-such-slug" }),
  ).toBe(
    "not_found: no project no-such-slug: pass the slug (like launch-q4) of a project this key reaches; list_projects (GET /api/v1/projects) lists them",
  );
});

test("a webhook that stops following a product drops the queued events of projects that no longer draw from a product it follows", async () => {
  onTestFinished(() => {
    db.delete(webhookSubscription).run();
  });
  const zeta = await productBot("Zeta unfollows");
  const beta = await productBot("Beta unfollowed");
  const hook = (
    await call(zeta.client, "create_webhook", {
      url: "https://zeta.example.com/unfollow",
      secret: "whsec_projects_0123456789",
      products: [zeta.product.key, beta.product.key],
    })
  ).id as string;
  const kept = freshSlug();
  const dropped = freshSlug();
  await call(zeta.client, "create_project", {
    name: "kept",
    slug: kept,
    products: [zeta.product.key, beta.product.key],
  });
  await call(beta.client, "create_project", {
    name: "dropped",
    slug: dropped,
    products: [beta.product.key],
  });
  const queued = () =>
    db
      .select({ type: webhookDelivery.type })
      .from(webhookDelivery)
      .where(eq(webhookDelivery.subscriptionId, hook))
      .all();
  expect(queued()).toHaveLength(2);

  await call(zeta.client, "update_webhook", {
    webhookId: hook,
    products: [zeta.product.key],
  });
  // the project still drawing from Zeta's product keeps its event
  expect(queued()).toEqual([{ type: "trail.project.created" }]);
});

test("get_project and GET /projects/{slug} carry one progress, by product A to Z, notes nowhere", async () => {
  const one = await productBot("Progress One");
  const two = await productBot("Progress Two");
  const slug = freshSlug();
  await call(one.client, "create_project", {
    name: "Progress",
    slug,
    products: [one.product.key, two.product.key],
  });
  const todo = async (
    client: typeof one.client,
    product: string,
    patch: Body,
  ) => {
    const { key } = await call(client, "add_todo", { product, title: "t" });
    if (Object.keys(patch).length > 0)
      await call(client, "update_item", { item: key, ...patch });
    return key as string;
  };
  const p = one.product.key;
  const keys = [
    await todo(one.client, p, { estimate: 2 }),
    await todo(one.client, p, { status: "in_progress", estimate: 3 }),
    await todo(one.client, p, { status: "done", estimate: 1.5 }),
    await todo(one.client, p, { status: "canceled", estimate: 8 }),
    (await call(one.client, "file_issue", { product: p, title: "untriaged" }))
      .key,
    await todo(two.client, two.product.key, { estimate: 10 }),
    await todo(two.client, two.product.key, {}),
  ];
  await call(one.client, "add_to_project", { project: slug, items: keys });
  await call(one.client, "add_note", {
    product: p,
    title: "a note counts nowhere",
    project: slug,
  });

  const reader = createBot(db, "progress reader", {
    scope: { products: [p] },
  }).key;
  const viaMcp = await call(await connect(reader), "get_project", {
    project: slug,
  });
  const res = await request("GET", `/api/v1/projects/${slug}`, {
    key: reader,
  });
  expect(res.status).toBe(200);
  const viaRest = (await res.json()) as Body;
  const products = [
    {
      key: p,
      name: "Progress One's product",
      inScope: 3,
      done: 1,
      inProgress: 1,
      open: 1,
      hoursLeft: 5,
      unfinishedWithoutEstimate: 0,
    },
    {
      key: two.product.key,
      name: "Progress Two's product",
      inScope: 2,
      done: 0,
      inProgress: 0,
      open: 2,
      hoursLeft: 10,
      unfinishedWithoutEstimate: 1,
    },
  ].sort((a, b) => a.key.localeCompare(b.key));
  expect(viaMcp.progress).toEqual({
    itemsInScope: 5,
    itemsDone: 1,
    itemsInProgress: 1,
    itemsOpen: 3,
    itemsTriage: 1,
    itemsCanceled: 1,
    donePercent: 20,
    hoursEstimated: 16.5,
    hoursDone: 1.5,
    hoursLeft: 15,
    hoursDonePercent: 9,
    unfinishedWithoutEstimate: 1,
    target: { date: null, status: "none", daysAway: null },
    byProduct: products,
  });
  expect(viaRest.progress).toEqual(viaMcp.progress);
});

test("a key that reaches a project only through one product or by listing it reads the progress of every item in it", async () => {
  const one = await productBot("Reach One");
  const two = await productBot("Reach Two");
  const slug = freshSlug();
  await call(one.client, "create_project", {
    name: "Reach",
    slug,
    products: [one.product.key, two.product.key],
  });
  const mine = await call(one.client, "add_todo", {
    product: one.product.key,
    title: "mine",
    estimate: 2,
  });
  const theirs = await call(two.client, "add_todo", {
    product: two.product.key,
    title: "theirs",
    estimate: 4,
  });
  await call(two.client, "update_item", { item: theirs.key, status: "done" });
  const hiddenTriage = await call(two.client, "file_issue", {
    product: two.product.key,
    title: "untriaged",
  });
  await call(one.client, "add_to_project", {
    project: slug,
    items: [mine.key, theirs.key, hiddenTriage.key],
  });

  const everything = (await call(one.client, "get_project", { project: slug }))
    .progress;
  expect(everything).toMatchObject({
    itemsInScope: 2,
    itemsDone: 1,
    itemsOpen: 1,
    itemsTriage: 1,
    hoursEstimated: 6,
    hoursDone: 4,
  });
  expect(everything.byProduct.map((p: Body) => [p.key, p.inScope])).toEqual(
    [
      [one.product.key, 1],
      [two.product.key, 1],
    ].sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
  // a key listing only the other product, and a key listing only the project
  const scopes: [string, { products?: string[]; projects?: string[] }][] = [
    ["other product", { products: [two.product.key] }],
    ["project", { projects: [slug] }],
    ["first product", { products: [one.product.key] }],
  ];
  for (const [name, scope] of scopes) {
    const key = createBot(db, `reach reader of ${name}`, { scope }).key;
    const viaMcp = await call(await connect(key), "get_project", {
      project: slug,
    });
    expect(viaMcp.progress).toEqual(everything);
    const res = await request("GET", `/api/v1/projects/${slug}`, { key });
    expect(((await res.json()) as Body).progress).toEqual(everything);
  }
});

test("the target date reads against the UTC day on get_project and GET /projects/{slug}: upcoming, and overdue with every item done", async () => {
  const owner = await productBot("Target Owner");
  const product = owner.product.key;
  const upcoming = freshSlug();
  const overdue = freshSlug();
  await call(owner.client, "create_project", {
    name: "later",
    slug: upcoming,
    targetDate: "2026-12-01",
    products: [product],
  });
  await call(owner.client, "create_project", {
    name: "late",
    slug: overdue,
    targetDate: "2026-11-20",
    products: [product],
  });
  const finished = await call(owner.client, "add_todo", {
    product,
    title: "finished",
  });
  await call(owner.client, "update_item", {
    item: finished.key,
    status: "done",
  });
  await call(owner.client, "add_to_project", {
    project: overdue,
    items: [finished.key],
  });

  // the last minute of the 28th in UTC: a local-day reading would differ in most zones
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  vi.setSystemTime(Date.parse("2026-11-28T23:59:00Z"));
  const read = async (slug: string) => {
    const viaMcp = (await call(owner.client, "get_project", { project: slug }))
      .progress;
    const res = await request("GET", `/api/v1/projects/${slug}`, {
      key: owner.key,
    });
    expect(((await res.json()) as Body).progress.target).toEqual(viaMcp.target);
    return viaMcp;
  };
  expect((await read(upcoming)).target).toEqual({
    date: "2026-12-01",
    status: "upcoming",
    daysAway: 3,
  });
  const late = await read(overdue);
  expect(late).toMatchObject({
    itemsInScope: 1,
    itemsDone: 1,
    donePercent: 100,
  });
  expect(late.target).toEqual({
    date: "2026-11-20",
    status: "overdue",
    daysAway: -8,
  });
});
