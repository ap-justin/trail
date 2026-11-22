import { describe, expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import { mcpClients } from "./test-client.js";

const { app, bot, request } = setupTestApp();
const { connect } = mcpClients(app);

type Schema = { properties?: Record<string, unknown> };
type Operation = {
  parameters?: { in: string; name: string }[];
  requestBody?: { content: { "application/json": { schema: Schema } } };
};

/** Tools with no request field beyond how they name their one target or the page, or no route that shares their shape. */
const noRoute = [
  "get_item",
  "get_project",
  "get_product",
  "get_issue",
  "get_thread",
  "list_labels",
  "list_status_updates",
  "remove_from_project",
  "list_webhooks",
  "delete_webhook",
  "test_webhook",
  "whoami",
  "set_my_photo",
  "clear_my_photo",
  "clear_my_title",
];

/** What each REST operation takes in its body and query, which the MCP tool beside it must take under the same names. */
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
  { tool: "list_activity", rest: "get /activity" },
  { tool: "import_project", rest: "post /import" },
  { tool: "set_my_title", rest: "put /me/title" },
  {
    tool: "post_status_update",
    rest: "post /products/{key}/status-updates",
    toolOnly: ["product", "project", "projectId", "idempotency_key"],
  },
  {
    tool: "create_label",
    rest: "post /products/{key}/labels",
    toolOnly: ["product", "projectId", "idempotency_key"],
  },
  // the legacy pair, deprecated alike on both
  { tool: "create_issue", rest: "post /issues", toolOnly: ["idempotency_key"] },
  { tool: "list_issues", rest: "get /issues" },
  { tool: "update_issue", rest: "patch /issues/{id}", toolOnly: ["issueId"] },
];

const surface = async () => {
  const { tools } = await (await connect(bot.key)).listTools();
  const spec = (await (
    await request("GET", "/api/v1/openapi.json", {})
  ).json()) as {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, Schema> };
  };
  const operation = (route: string) => {
    const [method, path] = route.split(" ") as [string, string];
    const op = spec.paths[path]?.[method];
    if (!op) throw new Error(`no route ${route}`);
    return op;
  };
  const routeFields = (route: string) => {
    const op = operation(route);
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
  const toolFields = (tool: string) => {
    const found = tools.find((t) => t.name === tool);
    if (!found) throw new Error(`no tool ${tool}`);
    return Object.keys((found.inputSchema as Schema).properties ?? {});
  };
  const takesIdempotencyHeader = (route: string) =>
    (operation(route).parameters ?? []).some(
      (p) => p.in === "header" && p.name.toLowerCase() === "idempotency-key",
    );
  return {
    toolNames: tools.map((t) => t.name),
    routeFields,
    toolFields,
    takesIdempotencyHeader,
  };
};

let loaded: ReturnType<typeof surface> | undefined;
const load = () => {
  loaded ??= surface();
  return loaded;
};

describe.each(pairs)("$tool against $rest", (pair) => {
  const { tool, rest, toolOnly = [], restOnly = [] } = pair;

  test("a field both take has one name", async () => {
    const { toolFields, routeFields } = await load();
    expect(
      toolFields(tool)
        .filter((f) => !toolOnly.includes(f))
        .sort(),
    ).toEqual(
      routeFields(rest)
        .filter((f) => !restOnly.includes(f))
        .sort(),
    );
  });

  test("every exemption is a field that still exists", async () => {
    const { toolFields, routeFields } = await load();
    expect(
      toolOnly.filter((f) => !toolFields(tool).includes(f)),
      "toolOnly names a field the tool no longer has",
    ).toEqual([]);
    expect(
      restOnly.filter((f) => !routeFields(rest).includes(f)),
      "restOnly names a field the route no longer has",
    ).toEqual([]);
  });

  test("a route taking an Idempotency-Key header has a tool taking idempotency_key", async () => {
    const { toolFields, takesIdempotencyHeader } = await load();
    expect(toolFields(tool).includes("idempotency_key")).toBe(
      takesIdempotencyHeader(rest),
    );
  });
});

describe("the exemption tables", () => {
  test("every tool has a pair or an entry in noRoute", async () => {
    const { toolNames } = await load();
    const covered = new Set(pairs.map((p) => p.tool));
    expect(
      toolNames.filter((name) => !covered.has(name) && !noRoute.includes(name)),
      "tools with no pair above and no entry in noRoute",
    ).toEqual([]);
  });

  test("every noRoute entry is a tool that still exists", async () => {
    const { toolNames } = await load();
    expect(noRoute.filter((name) => !toolNames.includes(name))).toEqual([]);
  });

  test("no tool is both paired and in noRoute", () => {
    const paired = new Set(pairs.map((p) => p.tool));
    expect(noRoute.filter((name) => paired.has(name))).toEqual([]);
  });
});
