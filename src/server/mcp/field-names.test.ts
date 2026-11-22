import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import { mcpClients } from "./test-client.js";

const { app, bot, request } = setupTestApp();
const { connect } = mcpClients(app);

type Schema = { properties?: Record<string, unknown> };
type Operation = {
  parameters?: { in: string; name: string }[];
  requestBody?: { content: { "application/json": { schema: Schema } } };
};

/** What each REST operation takes in its body and query, which the MCP tool beside it must take under the same names. */
/** Tools with no request field beyond how they name their one target or the page, or no route that shares their shape. */
const noRoute = [
  "get_item",
  "get_project",
  "get_product",
  "get_issue",
  "get_thread",
  "list_activity",
  "list_labels",
  "create_label",
  "list_status_updates",
  "post_status_update",
  "remove_from_project",
  "list_webhooks",
  "delete_webhook",
  "test_webhook",
  "whoami",
  "set_my_photo",
  "clear_my_photo",
  "set_my_title",
  "clear_my_title",
  "import_project",
];

const pairs: {
  tool: string;
  rest: string;
  /** What only the tool takes: how it names the item, the idempotency key REST sends as a header, aliases. */
  toolOnly?: string[];
  /** What only the route takes. */
  restOnly?: string[];
}[] = [
  // add_todo, file_issue and add_note are POST /items split by type, each with its own subset
  {
    tool: "file_issue",
    rest: "post /items",
    toolOnly: ["idempotency_key"],
    restOnly: ["type", "about"],
  },
  {
    tool: "add_todo",
    rest: "post /items",
    toolOnly: ["idempotency_key"],
    restOnly: ["type", "about", "project", "filed_for"],
  },
  {
    tool: "add_note",
    rest: "post /items",
    toolOnly: ["idempotency_key"],
    restOnly: ["type", "estimate", "priority", "assignee", "filed_for"],
  },
  { tool: "update_item", rest: "patch /items/{key}", toolOnly: ["item"] },
  { tool: "list_items", rest: "get /items" },
  {
    tool: "add_comment",
    rest: "post /items/{key}/comments",
    toolOnly: ["item", "issueId", "idempotency_key"],
  },
  {
    tool: "list_comments",
    rest: "get /items/{key}/comments",
    toolOnly: ["item", "issueId"],
  },
  {
    tool: "create_product",
    rest: "post /products",
    toolOnly: ["idempotency_key"],
  },
  { tool: "list_products", rest: "get /products" },
  {
    tool: "update_product",
    rest: "patch /products/{key}",
    toolOnly: ["product"],
  },
  { tool: "create_team", rest: "post /teams", toolOnly: ["idempotency_key"] },
  {
    tool: "create_project",
    rest: "post /projects",
    toolOnly: ["idempotency_key"],
  },
  {
    tool: "update_project",
    rest: "patch /projects/{ref}",
    toolOnly: ["project", "projectId"],
  },
  { tool: "list_projects", rest: "get /projects" },
  {
    tool: "add_to_project",
    rest: "post /projects/{slug}/items",
    toolOnly: ["project"],
  },
  { tool: "create_webhook", rest: "post /webhooks" },
  {
    tool: "update_webhook",
    rest: "patch /webhooks/{id}",
    toolOnly: ["webhookId"],
  },
  {
    tool: "rotate_webhook_secret",
    rest: "put /webhooks/{id}/secret",
    toolOnly: ["webhookId"],
  },
  {
    tool: "message_bot",
    rest: "post /messages",
    toolOnly: ["idempotency_key"],
  },
  { tool: "list_inbox", rest: "get /messages" },
  { tool: "mark_read", rest: "post /messages/read" },
  { tool: "list_bots", rest: "get /bots" },
  // the legacy pair, deprecated alike on both
  { tool: "create_issue", rest: "post /issues", toolOnly: ["idempotency_key"] },
  { tool: "list_issues", rest: "get /issues" },
  { tool: "update_issue", rest: "patch /issues/{id}", toolOnly: ["issueId"] },
];

test("a field the REST route and its MCP tool share has one name", async () => {
  const { tools } = await (await connect(bot.key)).listTools();
  const spec = (await (
    await request("GET", "/api/v1/openapi.json", {})
  ).json()) as {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, Schema> };
  };
  const restFields = (route: string) => {
    const [method, path] = route.split(" ") as [string, string];
    const op = spec.paths[path]?.[method];
    if (!op) throw new Error(`no route ${route}`);
    let body = op.requestBody?.content["application/json"].schema;
    const ref = (body as { $ref?: string } | undefined)?.$ref;
    if (ref) body = spec.components.schemas[ref.split("/").pop() as string];
    return [
      ...(op.parameters ?? [])
        .filter((p) => p.in === "query")
        .map((p) => p.name),
      ...Object.keys(body?.properties ?? {}),
    ];
  };
  for (const { tool, rest, toolOnly = [], restOnly = [] } of pairs) {
    const found = tools.find((t) => t.name === tool);
    if (!found) throw new Error(`no tool ${tool}`);
    const toolFields = Object.keys(
      (found.inputSchema as Schema).properties ?? {},
    );
    const routeFields = restFields(rest);
    expect(
      toolFields.filter((f) => !toolOnly.includes(f)).sort(),
      `${tool} against ${rest}`,
    ).toEqual(routeFields.filter((f) => !restOnly.includes(f)).sort());
  }
  // a tool added without a line in pairs would go unchecked
  const covered = new Set(pairs.map((p) => p.tool));
  const unpaired = tools
    .map((t) => t.name)
    .filter((name) => !covered.has(name) && !noRoute.includes(name));
  expect(unpaired, "tools with no pair above and no entry in noRoute").toEqual(
    [],
  );
});
