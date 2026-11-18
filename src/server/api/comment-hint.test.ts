import { beforeAll, expect, test } from "vitest";
import { projectKey, setupTestApp } from "../test-app.js";

const { request } = setupTestApp();

let key = "";
beforeAll(async () => {
  const product = await request("POST", "/api/v1/products", {
    json: { key: projectKey(), name: "hints" },
  });
  const { id } = (await product.json()) as { id: string };
  const item = await request("POST", "/api/v1/items", {
    json: { type: "todo", product: id, title: "ship the export" },
  });
  key = ((await item.json()) as { key: string }).key;
});

async function comment(body: string, headers: Record<string, string> = {}) {
  const res = await request("POST", `/api/v1/items/${key}/comments`, {
    json: { body },
    headers,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; body: string; hint?: string };
}

async function savedBodies() {
  const res = await request("GET", `/api/v1/items/${key}/comments?limit=100`);
  const page = (await res.json()) as { items: { body: string }[] };
  return page.items.map((c) => c.body);
}

const runUrl = "https://github.com/example-org/widget/actions/runs/1234567890";

test("a plain status comment gets no hint", async () => {
  const body =
    "Export works for CSV; JSON waits on the schema decision from the data bot.";
  const created = await comment(body);
  expect(created).not.toHaveProperty("hint");
  expect(await savedBodies()).toContain(body);
});

test("a body with two commit SHAs is saved and gets a hint naming them and the next step", async () => {
  const body = "Pushed 3f9c2a1 and then b71e04d9 to fix the lint.";
  const created = await comment(body);
  expect(created.body).toBe(body);
  expect(created.hint).toMatch(/build log: 2 commit SHAs/);
  expect(created.hint).toMatch(/update_item addLinks/);
  expect(created.hint).toMatch(/status, a decision or a blocker/);
  expect(await savedBodies()).toContain(body);
});

test("a long body with one run URL gets a hint", async () => {
  const body = `CI is green: ${runUrl}\n${"Every step passed as expected. ".repeat(20)}`;
  expect(body.length).toBeGreaterThan(600);
  const created = await comment(body);
  expect(created.hint).toMatch(/1 CI run\b/);
  expect(await savedBodies()).toContain(body);
});

test("a short body with one token gets no hint", async () => {
  const body = `Merged; see ${runUrl} for the deploy.`;
  const created = await comment(body);
  expect(created).not.toHaveProperty("hint");
  expect(await savedBodies()).toContain(body);
});

test("agent run ids and bare run ids count; plain words and numbers don't", async () => {
  expect(
    (await comment("Done in agt_7Hk2pQ9xR4 after req_88abZt31Lm.")).hint,
  ).toMatch(/2 agent run ids/);
  expect(
    (await comment("Run 1234567890 failed, retried as 1234567891.")).hint,
  ).toMatch(/2 CI runs/);
  expect(
    await comment(
      "Decided: we run_tests nightly, cap at 12345678 rows, and defer the facade.",
    ),
  ).not.toHaveProperty("hint");
});

test("a replay under the same Idempotency-Key answers the same hint and saves once", async () => {
  const body = "Rebased onto 9e8d7c6b and 0a1b2c3d4e.";
  const headers = { "idempotency-key": "hint-replay-1" };
  const first = await comment(body, headers);
  const again = await comment(body, headers);
  expect(again).toEqual(first);
  expect(first.hint).toMatch(/2 commit SHAs/);
  expect((await savedBodies()).filter((b) => b === body)).toHaveLength(1);
});

test("the legacy comment route answers the hint too", async () => {
  const res = await request("POST", `/api/v1/issues/${key}/comments`, {
    json: { body: "Head is now 5c4b3a2f1e after 6d5c4b3a." },
  });
  expect(res.status).toBe(201);
  expect(((await res.json()) as { hint?: string }).hint).toMatch(
    /2 commit SHAs/,
  );
});

test("the comment answer documents hint in the OpenAPI spec", async () => {
  const spec = (await (
    await request("GET", "/api/v1/openapi.json", { key: null })
  ).json()) as {
    paths: Record<
      string,
      {
        post?: {
          responses: Record<
            string,
            { content: Record<string, { schema: { $ref: string } }> }
          >;
        };
      }
    >;
    components: { schemas: Record<string, unknown> };
  };
  const ref =
    spec.paths["/items/{key}/comments"]?.post?.responses["201"]?.content[
      "application/json"
    ]?.schema.$ref ?? "";
  expect(ref).toBe("#/components/schemas/CreatedComment");
  // an extended schema may be an allOf over Comment
  expect(JSON.stringify(spec.components.schemas.CreatedComment)).toMatch(
    /"hint":\{"type":"string"/,
  );
});
