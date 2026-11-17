import { beforeAll, describe, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";

const { db, request } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

/** An unscoped write that must succeed, as the test app's own bot, which owns what it creates. */
async function seed(method: string, path: string, json: unknown) {
  const res = await request(method, path, { json });
  expect(res.status, `${method} ${path}`).toBeLessThan(300);
  return (await res.json()) as Body;
}

let alphaKey = "";
let atlIn = "";
let btaOut = "";

beforeAll(async () => {
  for (const key of ["ATL", "BTA"]) {
    await seed("POST", "/api/v1/products", { key, name: `Product ${key}` });
  }
  const atlInItem = await seed("POST", "/api/v1/items", {
    type: "todo",
    product: "ATL",
    title: "atl in",
  });
  atlIn = atlInItem.key;
  btaOut = (
    await seed("POST", "/api/v1/items", {
      type: "todo",
      product: "BTA",
      title: "bta out",
    })
  ).key;
  await seed("POST", "/api/v1/projects", {
    name: "Recon",
    slug: "recon",
    products: ["ATL", "BTA"],
  });
  await seed("POST", "/api/v1/projects/recon/items", { items: [atlIn] });
  alphaKey = createBot(db, "alpha", { scope: { projects: ["recon"] } }).key;
});

/** POST /items with type issue as alpha. */
const file = (json: Body, headers: Record<string, string> = {}) =>
  request("POST", "/api/v1/items", {
    key: alphaKey,
    json: { type: "issue", ...json },
    headers,
  });

describe("POST /items with type issue from a key scoped to project recon", () => {
  test("with project, a 201 with the issue in triage and in the project, and items outside it still 404", async () => {
    const res = await file({ product: "BTA", project: "recon", title: "gap" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Body;
    expect(body).toMatchObject({ product: "BTA", status: "triage" });
    expect(body.projects.map((p: Body) => p.slug)).toEqual(["recon"]);
    const read = await request("GET", `/api/v1/items/${body.key}`, {
      key: alphaKey,
    });
    expect(read.status).toBe(200);
    const hidden = await request("GET", `/api/v1/items/${btaOut}`, {
      key: alphaKey,
    });
    expect(hidden.status).toBe(404);
  });

  test("without project, the key's one project", async () => {
    const res = await file({ product: "BTA", title: "dflt" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Body;
    expect(body.projects.map((p: Body) => p.slug)).toEqual(["recon"]);
  });

  test("project alone on a project with two products is a 422 naming them", async () => {
    const res = await file({ project: "recon", title: "which" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Body).error.message).toBe(
      "project recon draws from ATL and BTA, so file_issue needs product: send product with one of them",
    );
  });

  test("a retry with the same Idempotency-Key replays the issue, in the project once", async () => {
    const send = () =>
      file(
        { product: "ATL", project: "recon", title: "once" },
        { "idempotency-key": "rest-once" },
      );
    const first = (await (await send()).json()) as Body;
    const again = await send();
    expect(again.status).toBe(201);
    expect(((await again.json()) as Body).id).toBe(first.id);
    const listed = await request(
      "GET",
      "/api/v1/items?project=recon&limit=200",
      { key: alphaKey },
    );
    const items = ((await listed.json()) as Body).items as Body[];
    expect(items.filter((i) => i.title === "once")).toHaveLength(1);
  });
});

describe("GET /products from a key scoped to project recon", () => {
  test("reads a product its project draws from as its id, key and name, and an unrestricted key reads it whole", async () => {
    const whole = (await seed(
      "GET",
      "/api/v1/products/BTA",
      undefined,
    )) as Body;
    expect(whole).toHaveProperty("description");
    const named = { id: whole.id, key: "BTA", name: "Product BTA" };
    const got = await request("GET", "/api/v1/products/BTA", { key: alphaKey });
    expect(await got.json()).toEqual(named);
    const listed = await request("GET", "/api/v1/products", { key: alphaKey });
    const items = ((await listed.json()) as Body).items as Body[];
    expect(items.find((p) => p.key === "BTA")).toEqual(named);
  });

  test("the legacy GET /projects/{productKey} reads it by the same id, key and name, and an unrestricted key whole", async () => {
    const whole = await seed("GET", "/api/v1/projects/BTA", undefined);
    expect(whole).toHaveProperty("description");
    expect(whole).toHaveProperty("createdBy");
    const got = await request("GET", "/api/v1/projects/BTA", { key: alphaKey });
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({
      id: whole.id,
      key: "BTA",
      name: "Product BTA",
      deprecated: whole.deprecated,
    });
  });
});

describe("POST /items from other keys", () => {
  test("an unrestricted key files without project as before, and into a project with it", async () => {
    const plain = await seed("POST", "/api/v1/items", {
      type: "issue",
      product: "BTA",
      title: "plain",
    });
    expect(plain.projects).toEqual([]);
    const joined = await seed("POST", "/api/v1/items", {
      type: "issue",
      product: "BTA",
      project: "recon",
      title: "joined",
    });
    expect(joined.projects.map((p: Body) => p.slug)).toEqual(["recon"]);
  });

  test("a todo with project is a 422 pointing to add_to_project", async () => {
    const res = await request("POST", "/api/v1/items", {
      json: { type: "todo", product: "BTA", project: "recon", title: "t" },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Body).error.message).toContain(
      "add_to_project",
    );
  });
});

describe("reads and filing from a key scoped to project recon", () => {
  let btaOutId = "";
  let twoProjects = "";

  beforeAll(async () => {
    await seed("POST", "/api/v1/products", { key: "CTX", name: "Product CTX" });
    await seed("POST", "/api/v1/projects", {
      name: "Other",
      slug: "other",
      products: ["ATL"],
    });
    await seed("POST", "/api/v1/products/ATL/labels", { name: "bug" });
    await seed("POST", `/api/v1/items/${atlIn}/comments`, { body: "seen" });
    await seed("POST", `/api/v1/items/${btaOut}/comments`, { body: "hidden" });
    await seed("POST", "/api/v1/projects/recon/status-updates", {
      body: "recon fine",
      health: "on_track",
    });
    await seed("POST", "/api/v1/products/ATL/status-updates", {
      body: "atl fine",
      health: "on_track",
    });
    btaOutId = (
      (await seed("GET", `/api/v1/items/${btaOut}`, undefined)) as Body
    ).id;
    twoProjects = createBot(db, "beta", {
      scope: { projects: ["recon", "other"] },
    }).key;
  });

  const read = async (path: string, key = alphaKey) => {
    const res = await request("GET", `/api/v1${path}`, { key });
    return { status: res.status, body: (await res.json()) as Body };
  };

  test("lists the project's items and none of the rest of its products", async () => {
    const inProject = await read("/items?project=recon&limit=200");
    const keys = inProject.body.items.map((i: Body) => i.key);
    expect(keys).toContain(atlIn);
    expect(keys).not.toContain(btaOut);
    const ofBta = await read("/items?product=BTA&limit=200");
    expect(ofBta.status).toBe(200);
    expect(ofBta.body.items.map((i: Body) => i.key)).not.toContain(btaOut);
  });

  test("a project it doesn't reach and a product it doesn't draw from are the 404 a missing one is", async () => {
    const missingProject = await read("/items?project=nowhere");
    const hiddenProject = await read("/items?project=other");
    expect(hiddenProject.status).toBe(404);
    expect(hiddenProject.body.error.message).toBe(
      missingProject.body.error.message.replace("nowhere", "other"),
    );
    const missingProduct = await read("/items?product=NOPE");
    const hiddenProduct = await read("/items?product=CTX");
    expect(hiddenProduct.status).toBe(404);
    expect(hiddenProduct.body.error.message).toBe(
      missingProduct.body.error.message.replace("NOPE", "CTX"),
    );
  });

  test("reads and adds comments on a project item, and neither on one outside it", async () => {
    const mine = await read(`/items/${atlIn}/comments`);
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((c: Body) => c.body)).toEqual(["seen"]);
    expect((await read(`/items/${btaOut}/comments`)).status).toBe(404);
    const refused = await request("POST", `/api/v1/items/${btaOut}/comments`, {
      key: alphaKey,
      json: { body: "x" },
    });
    expect(refused.status).toBe(404);
  });

  test("reads its project's status updates and not its products'", async () => {
    const own = await read("/projects/recon/status-updates");
    expect(own.status).toBe(200);
    expect(own.body.items.map((u: Body) => u.body)).toEqual(["recon fine"]);
    expect((await read("/products/ATL/status-updates")).status).toBe(404);
    expect((await read("/projects/other/status-updates")).status).toBe(404);
  });

  test("reads the labels of a product its project draws from, and not another's", async () => {
    const labels = await read("/products/ATL/labels");
    expect(labels.status).toBe(200);
    expect(labels.body.items.map((l: Body) => l.name)).toEqual(["bug"]);
    expect((await read("/products/CTX/labels")).status).toBe(404);
  });

  test("reads activity on the project's items, with no event of one outside it", async () => {
    const feed = await read("/activity?limit=200");
    expect(feed.status).toBe(200);
    const events = feed.body.items as Body[];
    expect(events.map((e) => e.action)).toContain("project.item_added");
    expect(events.some((e) => e.subjectId === btaOutId)).toBe(false);
    // the same read finds its events for a key that reaches them
    const whole = (await seed(
      "GET",
      "/api/v1/activity?limit=200",
      undefined,
    )) as Body;
    expect(whole.items.some((e: Body) => e.subjectId === btaOutId)).toBe(true);
    expect((await read("/activity?product=CTX")).status).toBe(404);
  });

  test("filing into a project it doesn't reach is the 404 a missing project gets, and files nothing", async () => {
    const before = (await read("/items?limit=200")).body.items.length;
    const refusal = async (project: string) => {
      const res = await file({ product: "ATL", project, title: "no" });
      return { status: res.status, body: (await res.json()) as Body };
    };
    const missing = await refusal("nowhere");
    const hidden = await refusal("other");
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.message).toBe(
      missing.body.error.message.replace("nowhere", "other"),
    );
    expect((await read("/items?limit=200")).body.items).toHaveLength(before);
  });

  test("a key naming two projects must send project, and files into the one it sends", async () => {
    const send = (json: Body) =>
      request("POST", "/api/v1/items", {
        key: twoProjects,
        json: { type: "issue", ...json },
      });
    const without = await send({ product: "ATL", title: "where" });
    expect(without.status).toBe(422);
    expect(((await without.json()) as Body).error.message).toBe(
      'this key reaches product ATL only through projects other and recon, so file_issue needs project: resend with project: "other" or project: "recon"',
    );
    const withProject = await send({
      product: "ATL",
      project: "other",
      title: "there",
    });
    expect(withProject.status).toBe(201);
    expect(
      ((await withProject.json()) as Body).projects.map((p: Body) => p.slug),
    ).toEqual(["other"]);
  });
});
