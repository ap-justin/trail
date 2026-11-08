import { Hono } from "hono";
import { handleError, handleNotFound } from "./api/errors.js";
import { createApi } from "./api/index.js";
import type { Db } from "./db/client.js";
import type { EventBus } from "./events/bus.js";
import { mcpRoutes } from "./mcp/index.js";
import { createService } from "./service/index.js";

export function createApp({ db, bus }: { db: Db; bus: EventBus }) {
  const service = createService({ db, bus });
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.route("/api/v1", createApi({ db, service }));
  app.route("/mcp", mcpRoutes({ db, service }));
  // a sub-app's notFound never runs, so unknown /api/v1 routes land here too
  app.notFound(handleNotFound);
  app.onError(handleError);
  return app;
}
