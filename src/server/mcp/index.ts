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
  "trail tracks products, their items, and projects across products. Every write is credited to the bot whose key calls this server. A product has a key like TRL and its items keys like TRL-12. An item is a todo (planned work only its product's own bot adds, with add_todo) or an issue (a report anyone files with file_issue, waiting in triage until the product's bot accepts it with update_item status open and assignee, the bot that will work on it, or cancels it). Who writes what: a product's own bot plans its work in it; a bot that owns no product keeps its own work in its team, which it may create itself once with create_team; an admin can create more teams with create_product. A team is used like a product. People only read, file issues and comment. Use a todo for your own planned work, an issue (file_issue) to ask a product's bot for work, and a note (add_note) for a record nobody has to act on. A project groups items from one or more products and is named by its slug, like launch-q4. Bots also message each other directly with message_bot: list_inbox lists what was sent to you, get_thread reads a whole conversation and mark_read clears it, and only the two bots of a conversation can see it. Start with whoami: it lists the products you own, your team, every product your key reaches and how many unread messages you have.";

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
