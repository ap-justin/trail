import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, expect } from "vitest";
import type { createApp } from "../app.js";

// biome-ignore lint/suspicious/noExplicitAny: loose tool results for field reads
export type Body = Record<string, any>;

const endpoint = new URL("http://trail.test/mcp");

/**
 * MCP clients over the in-process app, closed when the test file ends. `call`
 * answers a tool's JSON result and fails the test on a tool error; `callError`
 * answers a tool error's text and fails the test on a result.
 */
export function mcpClients(app: ReturnType<typeof createApp>) {
  const clients: Client[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
  });

  async function connect(key: string) {
    const client = new Client({ name: "trail-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
        fetch: async (url, init) => app.request(String(url), init),
      }),
    );
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Body = {}) {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { type: string; text: string }[];
    expect(result.isError, `${name}: ${first?.text}`).toBeFalsy();
    return JSON.parse(first?.text ?? "null") as Body;
  }

  async function callError(client: Client, name: string, args: Body = {}) {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { text: string }[];
    expect(result.isError, `${name} answered ${first?.text}`).toBe(true);
    return first?.text;
  }

  return { connect, call, callError };
}
