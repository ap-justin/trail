import { beforeAll, expect, test } from "vitest";
import { projectKey, setupTestApp } from "../test-app.js";
import { type Body, mcpClients } from "./test-client.js";

const { app, bot } = setupTestApp();
const { connect, call } = mcpClients(app);

let client: Awaited<ReturnType<typeof connect>>;
let item = "";
beforeAll(async () => {
  client = await connect(bot.key);
  const product = await call(client, "create_product", {
    key: projectKey(),
    name: "hints",
  });
  item = (
    await call(client, "add_todo", {
      product: product.key,
      title: "ship the export",
    })
  ).key;
});

const bodies = async () =>
  (
    (await call(client, "list_comments", { item, limit: 100 })).items as Body[]
  ).map((c) => c.body);

test("a plain status comment gets no hint and is saved", async () => {
  const body = "Blocked on the schema decision; the data bot clears it.";
  expect(await call(client, "add_comment", { item, body })).not.toHaveProperty(
    "hint",
  );
  expect(await bodies()).toContain(body);
});

test("a build-log body is saved and the result carries the hint", async () => {
  const body =
    "Head 3f9c2a1, CI https://github.com/example-org/widget/actions/runs/1234567890";
  const created = await call(client, "add_comment", { item, body });
  expect(created.body).toBe(body);
  expect(created.hint).toMatch(
    /build log: 1 commit SHA, 1 CI run\. .*update_item addLinks/,
  );
  expect(created.hint).not.toMatch(/PATCH/);
  expect(await bodies()).toContain(body);
});

test("a replay with the same idempotency_key answers the same hint", async () => {
  const args = {
    item,
    body: "Rebased onto 9e8d7c6b and 0a1b2c3d4e.",
    idempotency_key: "mcp-hint-replay-1",
  };
  const first = await call(client, "add_comment", args);
  expect(first.hint).toMatch(/2 commit SHAs/);
  expect(await call(client, "add_comment", args)).toEqual(first);
});
