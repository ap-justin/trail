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
let btaOut = "";

beforeAll(async () => {
  wide = await connect(bot.key);
  for (const key of ["ATL", "BTA"]) {
    await call(wide, "create_product", { key, name: `Product ${key}` });
  }
  const atlIn = await call(wide, "add_todo", { product: "ATL", title: "in" });
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
  await call(wide, "add_to_project", { project: "recon", items: [atlIn.key] });
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
  });
});

describe("the tool list leads a project-scoped key to filing", () => {
  test("list_projects, list_items, file_issue, list_products, get_product and whoami say how", async () => {
    const { tools } = await alpha.listTools();
    const describe = (name: string) =>
      tools.find((t) => t.name === name)?.description ?? "";
    expect(describe("list_projects")).toContain("projects this key reaches");
    expect(describe("list_items")).toContain("project");
    expect(describe("file_issue")).toContain("project");
    for (const name of ["list_products", "get_product", "whoami"]) {
      expect(describe(name), name).toContain("file_issue with project");
    }
    const fileIssue = tools.find((t) => t.name === "file_issue");
    expect(Object.keys(fileIssue?.inputSchema.properties ?? {})).toContain(
      "project",
    );
    expect(fileIssue?.inputSchema.required ?? []).not.toContain("product");
  });
});
