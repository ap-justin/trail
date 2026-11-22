import { Hono } from "hono";
import { getPath } from "hono/utils/url";
import { handleError, handleNotFound } from "./api/errors.js";
import { createApi } from "./api/index.js";
import type { TrailAuth } from "./auth/auth.js";
import { isLoopbackHost } from "./auth/preview.js";
import type { Db } from "./db/client.js";
import type { EventBus } from "./events/bus.js";
import type { PullRequests } from "./github/pull-requests.js";
import {
  type UnsubscribeKey,
  unsubscribeRoutes,
} from "./issue-end-mail/unsubscribe.js";
import { mcpRoutes } from "./mcp/index.js";
import { photoRoutes } from "./photos.js";
import { createService, type WebhookSettings } from "./service/index.js";
import { spaHandlers } from "./spa.js";
import type { LiveStreams } from "./web/events.js";
import { createWeb } from "./web/index.js";

export function createApp({
  db,
  bus,
  auth,
  streams,
  webDir,
  webhooks,
  pullRequests,
  unsubscribeKey,
}: {
  db: Db;
  bus: EventBus;
  auth: TrailAuth;
  /** the open event streams, which a drain ends */
  streams: LiveStreams;
  /** how webhooks are sealed, vetted and sent */
  webhooks: WebhookSettings;
  /** the GitHub pull request states item links show */
  pullRequests: PullRequests;
  /** signs the issue-ended email's unsubscribe links */
  unsubscribeKey: UnsubscribeKey;
  /** the built SPA (dist/web); without it only the API answers */
  webDir?: string;
}) {
  const service = createService({ db, bus, webhooks, pullRequests });
  const app = new Hono({
    // a bot configured with `.../mcp/` reaches the endpoint, not a 404 behind
    // the key check; trimTrailingSlash only redirects GET and HEAD
    getPath: (req) => {
      const path = getPath(req);
      return path === "/mcp/" ? "/mcp" : path;
    },
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  const { previewSignIn } = auth;
  if (previewSignIn) {
    // any other Host gets the 404 an unknown route gets, before the origin check can tell it exists
    app.post("/api/preview/sign-in", (c) =>
      isLoopbackHost(c.req.raw) ? previewSignIn(c.req.raw) : c.notFound(),
    );
  }
  app.route("/api/v1", createApi({ db, service }));
  app.route("/mcp", mcpRoutes({ db, service }));
  app.route("/api/web", createWeb({ db, service, bus, auth, streams }));
  app.route("/api/photos", photoRoutes({ db, auth }));
  app.route("/", unsubscribeRoutes({ db, key: unsubscribeKey }));
  const spa = webDir === undefined ? undefined : spaHandlers(webDir);
  if (spa) app.get("*", ...spa);
  // a sub-app's notFound never runs, so unknown /api/v1 routes land here too
  app.notFound(handleNotFound);
  app.onError(handleError);
  return app;
}
