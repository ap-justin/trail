import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import { mcpClients } from "./test-client.js";

const { app, bot, request } = setupTestApp();
const { connect } = mcpClients(app);

async function toolDescriptions() {
  const { tools } = await (await connect(bot.key)).listTools();
  return (name: string) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool;
  };
}

/** What a comment holds, and what stays on the pull request instead. */
function expectCommentGuidance(text: string | undefined, where: string) {
  expect(text, where).toMatch(/what changed for the work and why/);
  expect(text, where).toMatch(/a decision or scope change/);
  expect(text, where).toMatch(/a blocker and who clears it/);
  expect(text, where).toMatch(
    /commit SHAs, CI runs and logs, review findings and agent run ids/,
  );
  expect(text, where).toMatch(/pull request/);
  expect(text, where).toMatch(/links/);
}

test("add_comment says what a comment holds and that build detail stays on the pull request", async () => {
  const tool = await toolDescriptions();
  expectCommentGuidance(tool("add_comment").description, "add_comment");
});

test("POST comment routes, current and legacy, carry the same guidance", async () => {
  const spec = (await (
    await request("GET", "/api/v1/openapi.json", { key: null })
  ).json()) as {
    paths: Record<string, { post?: { description?: string } }>;
  };
  for (const path of ["/items/{key}/comments", "/issues/{id}/comments"]) {
    expectCommentGuidance(spec.paths[path]?.post?.description, path);
  }
});

test("update_item's links and addLinks say a pull request goes there and trail shows its state", async () => {
  const tool = await toolDescriptions();
  const properties = tool("update_item").inputSchema.properties as Record<
    string,
    { description?: string }
  >;
  for (const field of ["links", "addLinks"]) {
    expect(properties[field]?.description, field).toMatch(
      /pull request.*trail shows its state/,
    );
  }
});

test("post_status_update says where the project stands, not a changelog", async () => {
  const tool = await toolDescriptions();
  const description = tool("post_status_update").description;
  expect(description).toMatch(/where the project stands/);
  expect(description).toMatch(/risks/);
  expect(description).toMatch(/what's next/);
  expect(description).toMatch(/not a changelog/);
});
