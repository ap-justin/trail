import type { Db } from "../db/client.js";
import type { Service } from "../service/index.js";
import { activityRoutes } from "./activity.js";
import { actorRoutes } from "./actors.js";
import { bearerKey } from "./auth.js";
import { commentRoutes } from "./comments.js";
import { createRouter } from "./env.js";
import { handleError } from "./errors.js";
import { importRoutes } from "./import.js";
import { issueRoutes } from "./issues.js";
import { labelRoutes } from "./labels.js";
import { photoRoutes } from "./photos.js";
import { projectRoutes } from "./projects.js";
import { jsonBodiesOnly, limitBody, MAX_BODY_BYTES } from "./routes.js";
import { statusUpdateRoutes } from "./status-updates.js";
import { titleRoutes } from "./title.js";
import { webhookRoutes } from "./webhooks.js";

/** The `/api/v1` app: the spec is public, every other route needs a bot key. */
export function createApi({ db, service }: { db: Db; service: Service }) {
  const api = createRouter();
  api.onError(handleError);
  api.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
    description: "A bot's API key, as minted by `pnpm trail bot create`.",
  });
  // registered above the bearer middleware, which never runs for it
  api.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "trail", version: "1" },
    servers: [{ url: "/api/v1" }],
    security: [{ bearer: [] }],
  });
  api.use(bearerKey(db));
  api.use(jsonBodiesOnly);
  // Body limits sit behind the key check, so an unauthenticated caller can't make
  // them buffer a body. The import and the photo upload set their own and are
  // registered above the general limit, which never runs for them (the photo
  // delete reads no body).
  api.route("/", importRoutes(service));
  api.route("/", photoRoutes(service));
  api.use(limitBody(MAX_BODY_BYTES));
  api.route("/", projectRoutes(service));
  api.route("/", issueRoutes(service));
  api.route("/", commentRoutes(service));
  api.route("/", labelRoutes(service));
  api.route("/", statusUpdateRoutes(service));
  api.route("/", activityRoutes(service));
  api.route("/", actorRoutes(service));
  api.route("/", titleRoutes(service));
  api.route("/", webhookRoutes(service));
  return api;
}
