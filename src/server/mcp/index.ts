import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { bearerKey } from "../api/auth.js";
import type { ApiEnv } from "../api/env.js";
import { errorResponse, handleError } from "../api/errors.js";
import { IMPORT_MAX_BODY_BYTES, limitBody } from "../api/routes.js";
import type { Db } from "../db/client.js";
import type { Service } from "../service/index.js";
import { registerTools } from "./tools.js";

const instructions =
  "trail tracks projects, issues, comments and status updates. Every write is credited to the bot whose key calls this server. A project has a key like TRL and its issues keys like TRL-12: any argument naming a project or an issue takes its id or its key.";

/**
 * Streamable HTTP at `/mcp`, stateless: each POST gets a fresh server and
 * transport, so no session outlives its request. Behind the same bot key as `/api/v1`.
 */
export function mcpRoutes({ db, service }: { db: Db; service: Service }) {
  const mcp = new Hono<ApiEnv>();
  mcp.onError(handleError);
  mcp.use(bearerKey(db));
  // import_project carries a whole project
  mcp.use(limitBody(IMPORT_MAX_BODY_BYTES));
  mcp.post("/", async (c) => {
    const server = new McpServer(
      { name: "trail", version: "1" },
      { instructions },
    );
    registerTools(server, service, c.var.actor);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // one JSON reply per POST, no SSE stream left open on a machine that sleeps
      enableJsonResponse: true,
      maxRequestBodySize: IMPORT_MAX_BODY_BYTES,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  mcp.on(["GET", "DELETE"], "/", (c) => {
    c.header("Allow", "POST");
    return errorResponse(
      c,
      405,
      "method_not_allowed",
      "this MCP endpoint is stateless with no session or event stream: send each JSON-RPC message as a POST",
    );
  });
  return mcp;
}
