import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { beforeAll, describe, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";
import { type Body, mcpClients } from "./test-client.js";

const { app, db, bot } = setupTestApp();
const { connect, call, callError } = mcpClients(app);

let wide: Client;
let alpha: Client;
let beta: Client;
let atlIn = "";
let btaOut = "";

beforeAll(async () => {
  wide = await connect(bot.key);
  for (const key of ["ATL", "BTA"]) {
    await call(wide, "create_product", { key, name: `Product ${key}` });
  }
  const atlInItem = await call(wide, "add_todo", {
    product: "ATL",
    title: "in",
  });
  atlIn = atlInItem.key;
  btaOut = (await call(wide, "add_todo", { product: "BTA", title: "out" })).key;
  await call(wide, "create_project", {
    name: "Recon",
    slug: "recon",
    products: ["ATL", "BTA"],
  });
  await call(wide, "create_project", {
    name: "Solo",
    slug: "solo",
    products: ["BTA"],
  });
  await call(wide, "add_to_project", { project: "recon", items: [atlIn] });
  alpha = await connect(
    createBot(db, "alpha", { scope: { projects: ["recon"] } }).key,
  );
  beta = await connect(
    createBot(db, "beta", { scope: { projects: ["recon", "solo"] } }).key,
  );
});

describe("file_issue from a key scoped to projects", () => {
  test("with project, the issue is in triage and in the project, and items outside it still 404", async () => {
    const filed = await call(alpha, "file_issue", {
      product: "BTA",
      project: "recon",
      title: "gap",
    });
    expect(filed).toMatchObject({ product: "BTA", status: "triage" });
    expect(filed.projects.map((p: Body) => p.slug)).toEqual(["recon"]);
    expect((await call(alpha, "get_item", { item: filed.key })).title).toBe(
      "gap",
    );
    expect(await callError(alpha, "get_item", { item: btaOut })).toContain(
      `no item ${btaOut}`,
    );
  });

  test("without project, a key naming one project files into it", async () => {
    const filed = await call(alpha, "file_issue", {
      product: "BTA",
      title: "dflt",
    });
    expect(filed.projects.map((p: Body) => p.slug)).toEqual(["recon"]);
  });

  test("without project, a key naming two gets the projects to resend with", async () => {
    expect(
      await callError(beta, "file_issue", { product: "BTA", title: "where" }),
    ).toBe(
      'validation_failed: this key reaches product BTA only through projects recon and solo, so file_issue needs project: resend with project: "recon" or project: "solo"',
    );
  });

  test("project alone files on the project's one product", async () => {
    const filed = await call(beta, "file_issue", {
      project: "solo",
      title: "solo",
    });
    expect(filed.product).toBe("BTA");
  });

  test("a product the project does not draw from names those it does", async () => {
    expect(
      await callError(beta, "file_issue", {
        product: "ATL",
        project: "solo",
        title: "wrong",
      }),
    ).toContain("project solo draws from BTA, not ATL: send product with BTA");
  });

  test("a retry with the same idempotency_key replays the issue", async () => {
    const args = {
      product: "ATL",
      project: "recon",
      title: "once",
      idempotency_key: "mcp-once",
    };
    const first = await call(alpha, "file_issue", args);
    expect((await call(alpha, "file_issue", args)).id).toBe(first.id);
    const listed = await call(alpha, "list_items", {
      project: "recon",
      limit: 200,
    });
    expect(listed.items.filter((i: Body) => i.title === "once")).toHaveLength(
      1,
    );
  });

  test("a retry once the issue has left the project is the error a read of it is, without its title", async () => {
    const args = {
      product: "ATL",
      project: "recon",
      title: "gone quiet",
      idempotency_key: "mcp-left",
    };
    const first = await call(alpha, "file_issue", args);
    await call(wide, "remove_from_project", {
      project: "recon",
      items: [first.key],
    });

    const error = await callError(alpha, "file_issue", args);
    expect(error).not.toContain("gone quiet");
    expect(error).toBe(await callError(alpha, "get_item", { item: first.id }));
  });
});

describe("reads from a key scoped to project recon", () => {
  let btaOutId = "";

  beforeAll(async () => {
    await call(wide, "create_product", { key: "CTX", name: "Product CTX" });
    await call(wide, "create_project", {
      name: "Other",
      slug: "other",
      products: ["ATL"],
    });
    await call(wide, "create_label", { product: "ATL", name: "bug" });
    await call(wide, "add_comment", { item: atlIn, body: "seen" });
    await call(wide, "add_comment", { item: btaOut, body: "hidden" });
    await call(wide, "post_status_update", {
      project: "recon",
      body: "recon fine",
      health: "on_track",
    });
    await call(wide, "post_status_update", {
      product: "ATL",
      body: "atl fine",
      health: "on_track",
    });
    btaOutId = (await call(wide, "get_item", { item: btaOut })).id;
  });

  test("list_items lists the project's items and none of the rest of its products", async () => {
    const keys = async (args: Body) =>
      (await call(alpha, "list_items", { limit: 200, ...args })).items.map(
        (i: Body) => i.key,
      );
    expect(await keys({ project: "recon" })).toContain(atlIn);
    expect(await keys({ project: "recon" })).not.toContain(btaOut);
    expect(await keys({ product: "BTA" })).not.toContain(btaOut);
  });

  test("a project it doesn't reach and a product it doesn't draw from are the error a missing one is", async () => {
    const hiddenProject = await callError(alpha, "list_items", {
      project: "other",
    });
    expect(hiddenProject).toBe(
      (await callError(alpha, "list_items", { project: "nowhere" }))?.replace(
        "nowhere",
        "other",
      ),
    );
    expect(hiddenProject).toContain("not_found: no project other");
    const hiddenProduct = await callError(alpha, "list_items", {
      product: "CTX",
    });
    expect(hiddenProduct).toBe(
      (await callError(alpha, "list_items", { product: "NOPE" }))?.replace(
        "NOPE",
        "CTX",
      ),
    );
  });

  test("list_comments and add_comment work on a project item and 404 on one outside it", async () => {
    const mine = await call(alpha, "list_comments", { item: atlIn });
    expect(mine.items.map((c: Body) => c.body)).toEqual(["seen"]);
    expect(await callError(alpha, "list_comments", { item: btaOut })).toContain(
      `no item ${btaOut}`,
    );
    expect(
      await callError(alpha, "add_comment", { item: btaOut, body: "x" }),
    ).toContain(`no item ${btaOut}`);
  });

  test("list_status_updates reads the project's and not its products'", async () => {
    const own = await call(alpha, "list_status_updates", { project: "recon" });
    expect(own.items.map((u: Body) => u.body)).toEqual(["recon fine"]);
    expect(
      await callError(alpha, "list_status_updates", { product: "ATL" }),
    ).toContain("not_found");
    expect(
      await callError(alpha, "list_status_updates", { project: "other" }),
    ).toContain("not_found: no project other");
  });

  test("list_labels reads a product its project draws from and not another", async () => {
    const labels = await call(alpha, "list_labels", { product: "ATL" });
    expect(labels.items.map((l: Body) => l.name)).toEqual(["bug"]);
    expect(await callError(alpha, "list_labels", { product: "CTX" })).toContain(
      "not_found: no product CTX",
    );
  });

  test("list_activity shows the project's items and none outside it", async () => {
    const feed = await call(alpha, "list_activity", { limit: 200 });
    expect(feed.items.map((e: Body) => e.action)).toContain(
      "project.item_added",
    );
    const seen = (events: Body) =>
      events.items.some((e: Body) => JSON.stringify(e).includes(btaOutId));
    expect(seen(feed)).toBe(false);
    // the same read finds them for a key that reaches them
    expect(seen(await call(wide, "list_activity", { limit: 200 }))).toBe(true);
    expect(
      await callError(alpha, "list_activity", { product: "CTX" }),
    ).toContain("not_found");
  });
});

describe("get_project with a product key from a key scoped to projects", () => {
  test("reads the product by id, key and name, as get_product does, and an unrestricted key whole", async () => {
    const whole = await call(wide, "get_project", { project: "BTA" });
    expect(whole).toHaveProperty("description");
    expect(whole).toHaveProperty("createdBy");
    expect(await call(alpha, "get_project", { project: "BTA" })).toEqual({
      ...(await call(alpha, "get_product", { product: "BTA" })),
      deprecated: whole.deprecated,
    });
  });
});

describe("the tool list leads a project-scoped key to filing", () => {
  test("list_projects, list_items, file_issue, list_products, get_product and whoami say how", async () => {
    const { tools } = await alpha.listTools();
    const describe = (name: string) =>
      tools.find((t) => t.name === name)?.description ?? "";
    expect(describe("list_projects")).toContain("projects this key reaches");
    for (const name of ["list_products", "get_product", "whoami"]) {
      expect(describe(name), name).toContain("file_issue with project");
    }
    const listItems = tools.find((t) => t.name === "list_items");
    expect(Object.keys(listItems?.inputSchema.properties ?? {})).toContain(
      "project",
    );
    const fileIssue = tools.find((t) => t.name === "file_issue");
    expect(Object.keys(fileIssue?.inputSchema.properties ?? {})).toContain(
      "project",
    );
    expect(fileIssue?.inputSchema.required ?? []).not.toContain("product");
  });
});
