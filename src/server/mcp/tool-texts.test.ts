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

/** What a status update holds: where things stand, not what was done. */
function expectStatusGuidance(text: string | undefined, where: string) {
  expect(text, where).toMatch(/where the product or project stands/);
  expect(text, where).toMatch(/risks/);
  expect(text, where).toMatch(/what's next/);
  expect(text, where).toMatch(/not a changelog/);
}

test("post_status_update says where the product or project stands, not a changelog", async () => {
  const tool = await toolDescriptions();
  expectStatusGuidance(
    tool("post_status_update").description,
    "post_status_update",
  );
});

test("POST status-update routes, product and project, carry the same guidance", async () => {
  const spec = (await (
    await request("GET", "/api/v1/openapi.json", { key: null })
  ).json()) as {
    paths: Record<string, { post?: { description?: string } }>;
  };
  for (const path of [
    "/products/{key}/status-updates",
    "/projects/{ref}/status-updates",
  ]) {
    expectStatusGuidance(spec.paths[path]?.post?.description, path);
  }
});

test("add_todo, file_issue and add_note each say which item to add: planned work, a request for work, or a record nobody acts on", async () => {
  const tool = await toolDescriptions();
  for (const name of ["add_todo", "file_issue", "add_note"]) {
    const text = tool(name).description;
    expect(text, name).toMatch(/a todo is planned work/);
    expect(text, name).toMatch(/an issue asks a product's bot for work/);
    expect(text, name).toMatch(/a note is a record nobody has to act on/);
    expect(text, name).toMatch(
      /Anything in a note that someone has to act on goes in its own issue/,
    );
  }
});

/** How a note's events carry about: its own product's keys the reader reaches, the rest counted, never the full list. */
function expectNoteEventAbout(text: string | undefined, where: string) {
  expect(text, where).toMatch(/On its create event, about is an array of keys/);
  expect(text, where).toMatch(
    /of the items in the note's own product that the reading key reaches/,
  );
  expect(text, where).toMatch(/aboutOthers counts the rest/);
  expect(text, where).toMatch(
    /changes which items it is about.*carries about \{from, to\} and aboutOthers \{from, to\}/,
  );
  expect(text, where).toMatch(/not the note's full list/);
}

test("list_activity and create_webhook say how a note's events carry about and aboutOthers", async () => {
  const tool = await toolDescriptions();
  for (const name of ["list_activity", "create_webhook"]) {
    expectNoteEventAbout(tool(name).description, name);
  }
});

test("GET /activity's event payload and POST /webhooks say how a note's events carry about and aboutOthers", async () => {
  const spec = (await (
    await request("GET", "/api/v1/openapi.json", { key: null })
  ).json()) as {
    paths: Record<string, { post?: { description?: string } }>;
    components: {
      schemas: Record<
        string,
        { properties: Record<string, { description?: string }> }
      >;
    };
  };
  expectNoteEventAbout(
    spec.components.schemas.ActivityEvent?.properties.payload?.description,
    "ActivityEvent.payload",
  );
  expectNoteEventAbout(spec.paths["/webhooks"]?.post?.description, "/webhooks");
});

test("list_items says that without type it lists issues and todos only, and update_item says who edits a note", async () => {
  const tool = await toolDescriptions();
  expect(tool("list_items").description).toMatch(
    /Without type it lists issues and todos only/,
  );
  expect(tool("update_item").description).toMatch(
    /A note is edited only by its author and its product's own bot/,
  );
  expect(tool("get_item").description).toMatch(
    /list_items with about set to the item's key pages through all of them, archived ones too/,
  );
});
