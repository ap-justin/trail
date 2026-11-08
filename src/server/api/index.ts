import { bodyLimit } from "hono/body-limit";
import type { Db } from "../db/client.js";
import type { Service } from "../service/index.js";
import { activityRoutes } from "./activity.js";
import { bearerKey } from "./auth.js";
import { commentRoutes } from "./comments.js";
import { createRouter } from "./env.js";
import { errorResponse, handleError } from "./errors.js";
import { issueRoutes } from "./issues.js";
import { projectRoutes } from "./projects.js";
import { MAX_BODY_BYTES } from "./routes.js";

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
  // behind the key check, so an unauthenticated caller can't make it buffer a body
  api.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        errorResponse(
          c,
          413,
          "payload_too_large",
          `request body exceeds ${MAX_BODY_BYTES} bytes`,
        ),
    }),
  );
  api.route("/", projectRoutes(service));
  api.route("/", issueRoutes(service));
  api.route("/", commentRoutes(service));
  api.route("/", activityRoutes(service));
  return api;
}
