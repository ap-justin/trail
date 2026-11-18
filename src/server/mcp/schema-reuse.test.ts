import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, test } from "vitest";
import type { Service } from "../service/index.js";
import type { KeyActor } from "../service/keys.js";
import { registerTools } from "./tools.js";

/** The input schema each tool registered with, by tool name. */
function registeredSchemas() {
  const schemas = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, config: { inputSchema: unknown }) => {
      schemas.set(name, config.inputSchema);
    },
  } as unknown as McpServer;
  registerTools(server, {} as Service, {} as KeyActor);
  return schemas;
}

// zod-to-openapi keeps every schema derived from a described one in a process-wide map for good,
// and /mcp registers the tools on every POST: a schema built per call is a schema never freed
test("every request registers the tools with the same input schemas", () => {
  const first = registeredSchemas();
  const second = registeredSchemas();
  expect(first.size).toBeGreaterThan(30);
  for (const [name, schema] of second) {
    expect(schema, name).toBe(first.get(name));
  }
});
