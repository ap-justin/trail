import { expect, test } from "vitest";
import { ENDING_EMAIL } from "../api/items.js";
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

test("add_todo, file_issue and add_note each send what someone has to act on to its own issue", async () => {
  const tool = await toolDescriptions();
  for (const name of ["add_todo", "file_issue", "add_note"]) {
    const text = tool(name).description;
    expect(text, name).toMatch(
      /Anything in a note that someone has to act on goes in its own issue/,
    );
  }
});

/** How a note's events carry about: its own product's keys the reader reaches, the rest counted, never the full list. */
function expectNoteEventAbout(text: string | undefined, where: string) {
  expect(text, where).toMatch(/On its create event, about is an array of keys/);
  expect(text, where).toMatch(/aboutOthers counts the rest/);
  expect(text, where).toMatch(
    /changes which of its own product's items it is about, or how many others.*carries about \{from, to\} and aboutOthers \{from, to\}/,
  );
  expect(text, where).toMatch(
    /can change with no event when the change is outside the key's reach/,
  );
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

test("create_webhook and POST /webhooks say a note event naming items is rebuilt on every attempt", async () => {
  const tool = await toolDescriptions();
  const spec = (await (
    await request("GET", "/api/v1/openapi.json", { key: null })
  ).json()) as { paths: Record<string, { post?: { description?: string } }> };
  for (const [where, text] of [
    ["create_webhook", tool("create_webhook").description],
    ["/webhooks", spec.paths["/webhooks"]?.post?.description],
  ]) {
    expect(text, where).toMatch(
      /A note event whose payload carries about is the exception: it is built afresh on every attempt, so each retry, under the same delivery id, carries the subject, product, actor and url as they stand at that retry\./,
    );
  }
});

test("POST /items' project field says an issue or a note joins the project", async () => {
  const spec = (await (
    await request("GET", "/api/v1/openapi.json", { key: null })
  ).json()) as {
    components: {
      schemas: Record<
        string,
        { properties: Record<string, { description?: string }> }
      >;
    };
  };
  const project =
    spec.components.schemas.ItemCreate?.properties.project?.description;
  expect(project).toMatch(
    /^Issues and notes only \(a todo with it is a 422\)\. A project's slug, like launch-q4: the issue or note joins that project as it is added, and product must be one the project draws from/,
  );
});

test("update_item says ending an issue filed for a person with an address and access emails them the ender's or owner bot's latest comment, unless they unsubscribed", async () => {
  const tool = await toolDescriptions();
  expect(tool("update_item").description).toContain(ENDING_EMAIL);
  expect(ENDING_EMAIL).toMatch(
    /^Done or canceled on an item with a filedFor person emails them if trail has their address \(let in by email, or the verified GitHub primary address trail first read at sign-in\) and they can see its product, again on each later ending after a reopen, unless they have unsubscribed from these emails\. The email quotes your latest comment on the item, else the product's own bot's: comment the result or the reason first\.$/,
  );
});

test("update_item says who edits a note", async () => {
  const tool = await toolDescriptions();
  expect(tool("update_item").description).toMatch(
    /A note is edited only by its author and its product's own bot/,
  );
});

test("add_note's and file_issue's project fields say a key reaching one project defaults to it, and their product fields don't ask for project", async () => {
  const tool = await toolDescriptions();
  const field = (name: string, key: string) =>
    (
      tool(name).inputSchema.properties as Record<
        string,
        { description?: string }
      >
    )[key]?.description;
  for (const name of ["file_issue", "add_note"]) {
    expect(field(name, "project"), name).toMatch(
      /A key reaching a product only through projects sends `project` when it names more than one; with exactly one, that one is the default\./,
    );
    expect(field(name, "product"), name).not.toMatch(/needs project/);
  }
});

test("list_items and GET /items say that without type they list issues and todos only", async () => {
  const tool = await toolDescriptions();
  expect(tool("list_items").description).toMatch(
    /Without type it lists issues and todos only; notes need type "note" or about/,
  );
  const spec = (await (
    await request("GET", "/api/v1/openapi.json", { key: null })
  ).json()) as {
    paths: Record<string, { get?: { description?: string } }>;
  };
  expect(spec.paths["/items"]?.get?.description).toMatch(
    /Without type, issues and todos only: notes are listed with type note or about/,
  );
});

test("add_note says a note is a record nobody has to act on and file_issue that it is a request for work", async () => {
  const tool = await toolDescriptions();
  expect(tool("add_note").description).toMatch(
    /^Add a note: a record nobody has to act on/,
  );
  expect(tool("file_issue").description).toMatch(
    /a bug report or request for work to a product's bot/,
  );
});

test("the server's instructions say who writes what: products, teams, people, and which item to use", async () => {
  const text = (await connect(bot.key)).getInstructions();
  expect(text).toMatch(/Who writes what:/);
  expect(text).toMatch(
    /a bot that owns no product keeps its own work in its team, which it may create itself with create_team while it owns no product or team; an admin can create more teams with create_product/,
  );
  expect(text).toMatch(/People only read, file issues and comment/);
  expect(text).toMatch(
    /a todo for your own planned work, an issue \(file_issue\) to ask a product's bot for work, and a note \(add_note\) for a record nobody has to act on/,
  );
  expect(text).toMatch(/whoami: it lists the products you own, your team/);
});

test("filed_for and the handler: the instructions, file_issue, whoami and list_bots say what they are and where the email shows", async () => {
  const text = (await connect(bot.key)).getInstructions();
  expect(text).toMatch(
    /An issue you file on your person's behalf takes filed_for "handler"/,
  );
  expect(text).toMatch(
    /A person's own issue is filed for that person, emailed the same way when trail has their address: let in by email, or the verified GitHub primary address trail first read at sign-in\./,
  );
  const tool = await toolDescriptions();
  expect(tool("file_issue").description).toMatch(
    /filed_for "handler" when you file it on behalf of the person you work for, your handler/,
  );
  // one click in the mail client unsubscribes for good, so none of these promises every ending
  const promise =
    /each time (it|the issue) ends(?! unless they have unsubscribed from these emails)/;
  const fieldText = (
    tool("file_issue").inputSchema.properties as Record<
      string,
      { description?: string }
    >
  ).filed_for?.description;
  for (const said of [text, tool("file_issue").description, fieldText]) {
    expect(said).toMatch(/each time (it|the issue) ends/);
    expect(said).not.toMatch(promise);
  }
  expect(tool("whoami").description).toMatch(
    /handler \(the person you work for, with name and email, the one place a bot reads that address; null until the operator sets one/,
  );
  expect(tool("list_bots").description).toMatch(
    /handler \(the person it works for, by name alone, never the email; null when it has none\)/,
  );
});

test("create_team says who may create one, with which action, and what reaches it", async () => {
  const tool = await toolDescriptions();
  const text = tool("create_team").description;
  expect(text).toMatch(/Only a bot that owns no product and no team may/);
  expect(text).toMatch(/an admin can create more with create_product/);
  expect(text).toMatch(
    /A key limited only to projects is refused \(forbidden_scope\): it could not reach the team/,
  );
  expect(text).toMatch(/Needs the issues action, not admin/);
  expect(text).toMatch(
    /every key of yours limited to a list of products reaches it at once/,
  );
});

test("whoami describes team and hint; list_products, create_product and update_product describe kind", async () => {
  const tool = await toolDescriptions();
  expect(tool("whoami").description).toMatch(
    /team \(your own team, whether or not this key reaches it, or null; the first by key if an admin gave you several\)/,
  );
  expect(tool("whoami").description).toMatch(
    /hint \(only when you own no product and no team.*or which key to ask for when this one can't create a team\)/,
  );
  expect(tool("list_products").description).toMatch(
    /shows kind \(product or team.*kind lists only those of one kind, leaving out every product read only by id, key and name/,
  );
  expect(tool("create_product").description).toMatch(/kind team/);
  expect(tool("update_product").description).toMatch(/kind/);
  for (const name of ["add_todo", "file_issue", "add_note"]) {
    expect(tool(name).description, name).toMatch(
      /a todo is planned work you do in a product or team you own \(add_todo\)/,
    );
  }
});
