import { beforeAll, expect, test } from "vitest";
import { project, projectProduct } from "../db/schema.js";
import { atFakeTimeAsync, setupTestApp } from "../test-app.js";

const { db, bot, addBot, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

const json = async (res: Response) => (await res.json()) as Body;

let product: Body;
beforeAll(async () => {
  product = await json(
    await request("POST", "/api/v1/projects", {
      json: { key: "LEG", name: "legacy" },
    }),
  );
});

test("POST /projects with key creates a product, carrying deprecated", async () => {
  expect(product).toMatchObject({
    key: "LEG",
    owner: { id: bot.actor.id },
    deprecated: expect.stringMatching(/use create_product \(POST \/products\)/),
  });
});

test("the /issues routes serve items, each answer carrying deprecated", async () => {
  const filer = addBot("legacy rest filer");
  const created = await request("POST", "/api/v1/issues", {
    json: { projectId: "leg", title: "old route" },
    key: filer.key,
  });
  expect(created.status).toBe(201);
  const item = await json(created);
  // the old status enum has no triage: an issue waiting there reads as open
  expect(item).toMatchObject({
    type: "issue",
    status: "open",
    product: "LEG",
    deprecated: expect.stringMatching(/use add_todo/),
  });
  const read = await json(await request("GET", `/api/v1/issues/${item.key}`));
  expect(read.status).toBe("open");
  expect(
    (await json(await request("GET", `/api/v1/items/${item.key}`))).status,
  ).toBe("triage");
  expect(read.deprecated).toMatch(/use get_item \(GET \/items\/\{key\}\)/);
  const patched = await json(
    await request("PATCH", `/api/v1/issues/${item.key}`, {
      json: { status: "open", assigneeId: "tester" },
    }),
  );
  expect(patched).toMatchObject({
    status: "open",
    assigneeId: bot.actor.id,
    deprecated: expect.stringMatching(/use update_item/),
  });
  const page = await json(await request("GET", "/api/v1/issues?projectId=LEG"));
  expect(page.items.map((i: Body) => i.key)).toEqual([item.key]);
  const another = await json(
    await request("POST", "/api/v1/issues", {
      json: { projectId: "LEG", title: "still in triage" },
      key: filer.key,
    }),
  );
  const listed = await json(
    await request("GET", "/api/v1/issues?projectId=LEG"),
  );
  expect(listed.items.find((i: Body) => i.key === another.key)?.status).toBe(
    "open",
  );
  expect(page.deprecated).toMatch(/use list_items \(GET \/items\)/);
  const comment = await json(
    await request("POST", `/api/v1/issues/${item.key}/comments`, {
      json: { body: "old comment" },
    }),
  );
  expect(comment.deprecated).toMatch(/use \/items\/\{key\}\/comments/);
  const thread = await json(
    await request("GET", `/api/v1/issues/${item.key}/comments`),
  );
  expect(thread).toMatchObject({
    items: [{ body: "old comment" }],
    deprecated: expect.any(String),
  });
});

test("PATCH /issues/{id} keeps the owner rule: an outsider can't accept, cancel or retype a triage issue, nor reopen one the filer canceled", async () => {
  const filer = addBot("legacy rest owner filer");
  const outsider = addBot("legacy rest outsider");
  const filed = await json(
    await request("POST", "/api/v1/issues", {
      json: { projectId: "LEG", title: "owner decides" },
      key: filer.key,
    }),
  );
  const patch = (body: Body, key: string) =>
    request("PATCH", `/api/v1/issues/${filed.key}`, { json: body, key });
  for (const status of ["open", "canceled"]) {
    const res = await patch({ status }, outsider.key);
    expect(res.status, status).toBe(403);
    expect((await json(res)).error.message).toBe(
      `${filed.key} is in the triage of LEG, which tester owns: only tester accepts or cancels it, and its filer may cancel it. Comment on it with add_comment to ask tester`,
    );
  }
  const retyped = await patch({ type: "todo" }, outsider.key);
  expect(retyped.status).toBe(422);
  expect((await json(retyped)).error.message).toContain(
    'Unrecognized key "type"',
  );
  expect((await patch({ status: "canceled" }, filer.key)).status).toBe(200);
  const reopened = await patch({ status: "open" }, filer.key);
  expect(reopened.status).toBe(403);
  expect((await json(reopened)).error.message).toBe(
    `${filed.key} was filed on LEG, which tester owns, and was canceled: only tester reopens it. Comment on it with add_comment to ask tester`,
  );
  expect(
    await json(await request("GET", `/api/v1/items/${filed.key}`)),
  ).toMatchObject({ type: "issue", status: "canceled" });
});

test("PATCH /issues/{id} cancels an accepted issue or a todo only for the owner or the filer", async () => {
  const filer = addBot("legacy rest accepted filer");
  const outsider = addBot("legacy rest accepted outsider");
  const issue = await json(
    await request("POST", "/api/v1/issues", {
      json: { projectId: "LEG", title: "accepted then dropped" },
      key: filer.key,
    }),
  );
  const accepted = await request("PATCH", `/api/v1/issues/${issue.key}`, {
    json: { status: "open", assigneeId: "tester" },
  });
  expect(accepted.status).toBe(200);
  const todo = await json(
    await request("POST", "/api/v1/issues", {
      json: { projectId: "LEG", title: "owner's own" },
    }),
  );
  expect(todo.type).toBe("todo");
  for (const { key } of [issue, todo]) {
    const res = await request("PATCH", `/api/v1/issues/${key}`, {
      json: { status: "canceled" },
      key: outsider.key,
    });
    expect(res.status, key).toBe(403);
    expect((await json(res)).error.message, key).toBe(
      `${key} is on LEG, which tester owns: only tester or the bot that filed it cancels it. Comment on it with add_comment to ask tester`,
    );
  }
  const byFiler = await request("PATCH", `/api/v1/issues/${issue.key}`, {
    json: { status: "canceled" },
    key: filer.key,
  });
  expect((await json(byFiler)).status).toBe("canceled");
});

test("PATCH /issues/{id} by a bot outside the product creates no label, and says which it skipped", async () => {
  const outsider = addBot("legacy rest label patcher");
  const filed = await json(
    await request("POST", "/api/v1/issues", {
      json: { projectId: "LEG", title: "legacy labels" },
      key: outsider.key,
    }),
  );
  const res = await request("PATCH", `/api/v1/issues/${filed.key}`, {
    json: { addLabels: ["legacy-made-up"] },
    key: outsider.key,
  });
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({
    labels: [],
    skippedLabels: ["legacy-made-up"],
    deprecated: expect.stringMatching(/use update_item/),
  });
  const labels = await json(
    await request("GET", "/api/v1/products/LEG/labels"),
  );
  expect(labels.items.map((l: Body) => l.name)).not.toContain("legacy-made-up");
});

test("POST /products/{key}/labels and the deprecated /projects/{ref}/labels refuse a bot outside the owned product with the next step", async () => {
  const outsider = addBot("legacy rest label creator");
  for (const path of [
    "/api/v1/products/LEG/labels",
    "/api/v1/projects/LEG/labels",
  ]) {
    const res = await request("POST", path, {
      json: { name: "outsider-made" },
      key: outsider.key,
    });
    expect(res.status, path).toBe(403);
    expect(await json(res), path).toMatchObject({
      error: {
        code: "forbidden",
        message:
          'LEG is owned by tester, so only tester creates its labels: ask tester to create the label "outsider-made", or file or update the item without it, and a label LEG lacks comes back in skippedLabels',
      },
    });
  }
  const labels = await json(
    await request("GET", "/api/v1/products/LEG/labels"),
  );
  expect(labels.items.map((l: Body) => l.name)).not.toContain("outsider-made");
});

test("/projects/{KEY} that matches no slug names the product, carrying deprecated", async () => {
  const got = await json(await request("GET", "/api/v1/projects/leg"));
  expect(got).toMatchObject({
    key: "LEG",
    deprecated: expect.stringMatching(/use get_product/),
  });
  const patched = await json(
    await request("PATCH", "/api/v1/projects/LEG", {
      json: { description: "patched the old way" },
    }),
  );
  expect(patched).toMatchObject({
    description: "patched the old way",
    deprecated: expect.any(String),
  });
  const posted = await request("POST", "/api/v1/projects/LEG/status-updates", {
    json: { body: "old update", health: "on_track" },
  });
  expect(posted.status).toBe(201);
  expect(await json(posted)).toMatchObject({
    product: "LEG",
    deprecated: expect.any(String),
  });
  const updates = await json(
    await request("GET", "/api/v1/projects/LEG/status-updates"),
  );
  expect(updates).toMatchObject({
    items: [{ body: "old update" }],
    deprecated: expect.any(String),
  });
  const label = await json(
    await request("POST", "/api/v1/projects/LEG/labels", {
      json: { name: "Old" },
    }),
  );
  expect(label).toMatchObject({
    name: "Old",
    deprecated:
      "/projects/{key}/labels is deprecated: use /products/{key}/labels",
  });
  expect(
    (await json(await request("GET", "/api/v1/projects/LEG/labels"))).items,
  ).toHaveLength(1);
});

test("a slug equal to a product's key is a 409, and a name that derives one gets a suffix", async () => {
  const explicit = await request("POST", "/api/v1/projects", {
    json: { name: "leg", slug: "leg", products: ["LEG"] },
  });
  expect(explicit.status).toBe(409);
  expect((await json(explicit)).error.message).toBe(
    "slug leg is the key of product LEG, and a project's slug never matches a product's key: pick another slug, or leave slug out to derive a free one from the name",
  );
  const derived = await request("POST", "/api/v1/projects", {
    json: { name: "Leg", products: ["LEG"] },
  });
  expect(derived.status).toBe(201);
  expect((await json(derived)).slug).toBe("leg-2");
});

test("a name whose slug is a product's key, with the -2 suffix a project's slug, derives the -3 one", async () => {
  expect(
    (
      await request("POST", "/api/v1/products", {
        json: { key: "SLGX", name: "suffixed" },
      })
    ).status,
  ).toBe(201);
  const taken = await request("POST", "/api/v1/projects", {
    json: { name: "taken", slug: "slgx-2", products: ["SLGX"] },
  });
  expect(taken.status).toBe(201);
  const derived = await request("POST", "/api/v1/projects", {
    json: { name: "SLGX", products: ["SLGX"] },
  });
  expect(derived.status).toBe(201);
  expect((await json(derived)).slug).toBe("slgx-3");
});

test("a product key equal to a project's slug, in any case, is a 409", async () => {
  const made = await request("POST", "/api/v1/projects", {
    json: { name: "slug first", slug: "lgsf", products: ["LEG"] },
  });
  expect(made.status).toBe(201);
  for (const [path, body] of [
    ["/api/v1/products", {}],
    ["/api/v1/projects", {}],
    ["/api/v1/import", { externalRef: "ext-lgsf", issues: [] }],
  ] as const) {
    const res = await request("POST", path, {
      json: { key: "lgsf", name: "key second", ...body },
    });
    expect(res.status, path).toBe(409);
    expect((await json(res)).error.message, path).toBe(
      "product key LGSF is the slug of project lgsf, and a product's key never matches a project's slug: choose another key",
    );
  }
});

test("a ref that is both a project's slug and a product's key, from before slugs and keys were kept apart, names the project on every /projects/{ref} route", async () => {
  const stored = db
    .insert(project)
    .values({
      slug: "leg",
      name: "older project",
      leadId: bot.actor.id,
      createdBy: bot.actor.id,
    })
    .returning()
    .get();
  db.insert(projectProduct)
    .values({ projectId: stored.id, productId: product.id })
    .run();
  expect(
    await json(await request("GET", "/api/v1/projects/leg")),
  ).toMatchObject({ slug: "leg", name: "older project" });
  const renamed = await json(
    await request("PATCH", "/api/v1/projects/leg", {
      json: { name: "renamed" },
    }),
  );
  expect(renamed).toMatchObject({ slug: "leg", name: "renamed" });
  expect(renamed).not.toHaveProperty("deprecated");
  const posted = await request("POST", "/api/v1/projects/leg/status-updates", {
    json: { body: "which one", health: "at_risk" },
  });
  expect(posted.status).toBe(201);
  expect(await json(posted)).toMatchObject({ project: "leg", product: null });
  const listed = await json(
    await request("GET", "/api/v1/projects/leg/status-updates"),
  );
  expect(listed.items.map((u: Body) => u.body)).toEqual(["which one"]);
  // the upper-case key matches no slug, so it still reaches the product
  expect(
    await json(await request("GET", "/api/v1/projects/LEG")),
  ).toMatchObject({ key: "LEG", name: "legacy" });
});

test("a slug no product key matches names the project, its answers carrying no deprecated note", async () => {
  const project = await json(
    await request("POST", "/api/v1/projects", {
      json: { name: "leg plan", slug: "leg-plan", products: ["LEG"] },
    }),
  );
  expect(project).not.toHaveProperty("deprecated");
  expect(await json(await request("GET", "/api/v1/projects/leg-plan"))).toEqual(
    project,
  );
  const posted = await json(
    await request("POST", "/api/v1/projects/leg-plan/status-updates", {
      json: { body: "project update", health: "at_risk" },
    }),
  );
  expect(posted).toMatchObject({ project: "leg-plan", product: null });
  expect(posted).not.toHaveProperty("deprecated");
});

test("GET /projects lists projects, never products", async () => {
  await request("POST", "/api/v1/products", {
    json: { key: "LGL", name: "legacy list" },
  });
  const made = await request("POST", "/api/v1/projects", {
    json: { name: "lgl list", slug: "lgl-list", products: ["LGL"] },
  });
  expect(made.status).toBe(201);
  const page = await json(await request("GET", "/api/v1/projects?limit=200"));
  // the list is live: it holds the project this test just made
  expect(page.items.map((p: Body) => p.slug)).toContain("lgl-list");
  expect(page.items.every((p: Body) => typeof p.slug === "string")).toBe(true);
  expect(page.items.some((p: Body) => "key" in p)).toBe(false);
  expect(page.deprecated).toBe(
    "list_projects now lists projects (groups of items across products), not products: call list_products (GET /products) for those",
  );
});

test("GET /issues?status=open includes issues waiting in triage, as open meant before triage; GET /items keeps exact status", async () => {
  await request("POST", "/api/v1/products", {
    json: { key: "LGO", name: "legacy open" },
  });
  const create = async (title: string, key = bot.key) =>
    json(
      await request("POST", "/api/v1/issues", {
        json: { projectId: "LGO", title },
        key,
      }),
    );
  const filer = addBot("lgo filer").key;
  // one stamp apiece: same-millisecond rows would list in random id order
  const [filed, todo, started] = (await atFakeTimeAsync([
    () => create("filed by another bot", filer),
    () => create("planned"),
    () => create("started"),
  ])) as Body[];
  if (!filed || !todo || !started) throw new Error("a create answered nothing");
  await request("PATCH", `/api/v1/items/${started.key}`, {
    json: { status: "in_progress" },
  });
  expect([filed.type, todo.type]).toEqual(["issue", "todo"]);
  const keys = async (path: string) =>
    (await json(await request("GET", path))).items.map((i: Body) => i.key);

  expect(await keys("/api/v1/issues?projectId=LGO&status=open")).toEqual([
    todo.key,
    filed.key,
  ]);
  expect(await keys("/api/v1/issues?projectId=LGO&status=in_progress")).toEqual(
    [started.key],
  );
  expect(await keys("/api/v1/items?product=LGO&status=open")).toEqual([
    todo.key,
  ]);
});

test("POST and GET /issues take project or product as aliases of projectId, one spelling at a time", async () => {
  await request("POST", "/api/v1/products", {
    json: { key: "LGR", name: "legacy rest aliases" },
  });
  for (const [field, title] of [
    ["project", "via project"],
    ["product", "via product"],
  ] as const) {
    const res = await request("POST", "/api/v1/issues", {
      json: { [field]: "LGR", title },
    });
    expect(res.status, field).toBe(201);
  }
  for (const field of ["projectId", "project", "product"]) {
    const page = await json(
      await request("GET", `/api/v1/issues?${field}=lgr`),
    );
    expect(page.items.map((i: Body) => i.title).sort(), field).toEqual([
      "via product",
      "via project",
    ]);
  }
  const both = [
    await request("POST", "/api/v1/issues", {
      json: { projectId: "LGR", project: "LGR", title: "both" },
    }),
    await request("GET", "/api/v1/issues?projectId=LGR&product=LGR"),
  ];
  for (const res of both) {
    expect(res.status).toBe(422);
    expect((await json(res)).error.message).toBe(
      "send one of projectId, project or product: they name the same product, and two together is ambiguous",
    );
  }
});
