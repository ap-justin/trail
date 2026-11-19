import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, test } from "vitest";
import type { z } from "zod";
import type { Service } from "../service/index.js";
import type { KeyActor } from "../service/keys.js";
import { registerTools } from "./tools.js";

/** The input schema each tool registered with, by tool name. */
function registeredSchemas() {
  const schemas = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, config: { inputSchema: unknown }) => {
      if (schemas.has(name)) throw new Error(`tool registered twice: ${name}`);
      schemas.set(name, config.inputSchema);
    },
  } as unknown as McpServer;
  registerTools(server, {} as Service, {} as KeyActor);
  return schemas;
}

const TOOLS = [
  "add_comment",
  "add_note",
  "add_to_project",
  "add_todo",
  "clear_my_photo",
  "clear_my_title",
  "create_issue",
  "create_label",
  "create_product",
  "create_project",
  "create_webhook",
  "delete_webhook",
  "file_issue",
  "get_issue",
  "get_item",
  "get_product",
  "get_project",
  "get_thread",
  "import_project",
  "list_activity",
  "list_bots",
  "list_comments",
  "list_inbox",
  "list_issues",
  "list_items",
  "list_labels",
  "list_products",
  "list_projects",
  "list_status_updates",
  "list_webhooks",
  "mark_read",
  "message_bot",
  "post_status_update",
  "remove_from_project",
  "rotate_webhook_secret",
  "set_my_photo",
  "set_my_title",
  "test_webhook",
  "update_issue",
  "update_item",
  "update_product",
  "update_project",
  "update_webhook",
  "whoami",
];

// zod-to-openapi keeps every schema .openapi(...) returns, and every extend/optional/min called
// on one, in a process-wide map for good, and /mcp registers the tools on every POST: a
// schema built per call is a schema never freed
test("every request registers the tools with the same input schemas", () => {
  const first = registeredSchemas();
  const second = registeredSchemas();
  expect([...first.keys()].sort()).toEqual(TOOLS);
  expect([...second.keys()].sort()).toEqual(TOOLS);
  for (const [name, schema] of second) {
    expect(schema, name).toBe(first.get(name));
  }
});

test("each tool keeps its own input schema", () => {
  const schemas = registeredSchemas();
  expect(new Set(schemas.values()).size).toBe(schemas.size);
  const getItem = schemas.get("get_item") as z.ZodObject;
  const whoami = schemas.get("whoami") as z.ZodObject;
  expect(getItem.safeParse({ item: "TRL-1" }).success).toBe(true);
  expect(whoami.safeParse({ item: "TRL-1" }).success).toBe(false);
});
