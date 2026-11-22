import { describe, expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import { mcpClients } from "./test-client.js";

const { app, bot, request } = setupTestApp();
const { connect } = mcpClients(app);

type Schema = {
  properties?: Record<string, unknown>;
  $ref?: string;
  allOf?: unknown[];
  oneOf?: unknown[];
  anyOf?: unknown[];
};
type Operation = {
  parameters?: { in: string; name: string }[];
  requestBody?: { content: { "application/json": { schema: Schema } } };
};
type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

const operationOf = (spec: Spec, route: string) => {
  const [method, path] = route.split(" ") as [string, string];
  const op = spec.paths[path]?.[method];
  if (!op) throw new Error(`no route ${route}`);
  return op;
};

/**
 * The query parameters and body fields of a route. It reads a body that is plain `properties`, directly or through one
 * `$ref`, and throws on any other shape: a partial list would let the REST/MCP comparison pass on the fields it read.
 */
const readRouteFields = (spec: Spec, route: string) => {
  const op = operationOf(spec, route);
  const unreadable = (why: string) =>
    new Error(
      `${route} has a request body routeFields cannot read in full: ${why}`,
    );
  let bodyFields: string[] = [];
  if (op.requestBody) {
    let body: Schema | undefined =
      op.requestBody.content["application/json"]?.schema;
    if (body?.$ref) {
      body = spec.components.schemas[body.$ref.split("/").pop() as string];
      if (body?.$ref) throw unreadable("a $ref to a $ref");
    }
    for (const key of ["allOf", "oneOf", "anyOf"] as const) {
      // an `anyOf` of `{ required }` branches (IssueCreate's alias rule) adds no fields, so `properties` is still whole
      const addsFields = (body?.[key] ?? []).some(
        (branch) => Object.keys(branch as object).join() !== "required",
      );
      if (addsFields) throw unreadable(`its ${key} may add fields`);
    }
    if (!body?.properties) throw unreadable("it has no properties");
    bodyFields = Object.keys(body.properties);
  }
  return [
    ...(op.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name),
    ...bodyFields,
  ];
};

/**
 * The fields of a tool's input schema. Like `readRouteFields` it throws rather than return a partial list: a schema that
 * lost its `properties` (an anyOf, a $ref) would read as `[]` and pass against a route that reads as `[]` too.
 */
const readToolFields = (tool: string, schema: Schema) => {
  if (!schema.properties) {
    throw new Error(
      `tool ${tool} has an input schema toolFields cannot read in full: it has no properties`,
    );
  }
  return Object.keys(schema.properties);
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
  ).json()) as Spec;
  const operation = (route: string) => operationOf(spec, route);
  const routeFields = (route: string) => readRouteFields(spec, route);
  const toolFields = (tool: string) => {
    const found = tools.find((t) => t.name === tool);
    if (!found) throw new Error(`no tool ${tool}`);
    return readToolFields(tool, found.inputSchema as Schema);
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

describe("routeFields", () => {
  const specWith = (schema: Schema): Spec => ({
    paths: {
      "/x": {
        post: {
          parameters: [{ in: "query", name: "page" }],
          requestBody: { content: { "application/json": { schema } } },
        },
      },
    },
    components: {
      schemas: {
        Plain: { properties: { title: {}, body: {} } },
        Hop: { $ref: "#/components/schemas/Plain" },
      },
    },
  });
  const fields = (schema: Schema) =>
    readRouteFields(specWith(schema), "post /x");

  test("reads query parameters and the properties behind one $ref", () => {
    expect(fields({ $ref: "#/components/schemas/Plain" })).toEqual([
      "page",
      "title",
      "body",
    ]);
  });

  test("reads properties beside an anyOf of required-only branches", () => {
    expect(
      fields({
        properties: { title: {} },
        anyOf: [{ required: ["title"] }, { required: ["body"] }],
      }),
    ).toEqual(["page", "title"]);
  });

  test("reads inline properties", () => {
    expect(fields({ properties: { title: {} } })).toEqual(["page", "title"]);
  });

  test.each([
    ["allOf beside properties", { properties: { title: {} }, allOf: [{}] }],
    ["oneOf beside properties", { properties: { title: {} }, oneOf: [{}] }],
    ["anyOf with no properties", { anyOf: [{}] }],
    ["a $ref to a $ref", { $ref: "#/components/schemas/Hop" }],
    ["no properties", {}],
  ] as [string, Schema][])("throws on a body with %s", (_name, schema) => {
    expect(() => fields(schema)).toThrow(/cannot read in full/);
  });
});

describe("toolFields", () => {
  test("reads the properties of a tool schema", () => {
    expect(readToolFields("t", { properties: { a: {}, b: {} } })).toEqual([
      "a",
      "b",
    ]);
  });

  test("an empty properties object is a tool with no fields", () => {
    expect(readToolFields("t", { properties: {} })).toEqual([]);
  });

  test.each([
    ["no properties", {}],
    ["an anyOf in place of properties", { anyOf: [{ properties: { a: {} } }] }],
    ["a $ref in place of properties", { $ref: "#/$defs/Input" }],
  ] as [string, Schema][])("throws on a schema with %s", (_name, schema) => {
    expect(() => readToolFields("t", schema)).toThrow(
      "tool t has an input schema toolFields cannot read in full: it has no properties",
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
