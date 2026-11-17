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
let btaOut = "";

beforeAll(async () => {
  for (const key of ["ATL", "BTA"]) {
    await seed("POST", "/api/v1/products", { key, name: `Product ${key}` });
  }
  const atlIn = await seed("POST", "/api/v1/items", {
    type: "todo",
    product: "ATL",
    title: "atl in",
  });
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
  await seed("POST", "/api/v1/projects/recon/items", { items: [atlIn.key] });
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
