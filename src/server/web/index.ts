import { handleError } from "../api/errors.js";
import { limitBody, MAX_BODY_BYTES } from "../api/routes.js";
import type { TrailAuth } from "../auth/auth.js";
import type { Db } from "../db/client.js";
import type { EventBus } from "../events/bus.js";
import type { Service } from "../service/index.js";
import { createWebRouter, requireMember, requireOwnOrigin } from "./env.js";
import { eventRoutes } from "./events.js";
import { feedRoutes } from "./feed.js";
import { issueRoutes } from "./issues.js";
import { meRoutes } from "./me.js";
import { peopleRoutes } from "./people.js";
import { projectRoutes } from "./projects.js";
import { searchRoutes } from "./search.js";

/**
 * The `/api/web` app the SPA calls with a session cookie. `GET /me` answers
 * anyone; every other route needs a member, and every write the app's own Origin.
 */
export function createWeb({
  db,
  service,
  bus,
  auth,
  shutdown,
}: {
  db: Db;
  service: Service;
  bus: EventBus;
  auth: TrailAuth;
  shutdown: AbortSignal;
}) {
  const web = createWebRouter();
  web.onError(handleError);
  web.use(auth.viewer);
  // registered above the member guard, which never runs for it
  web.route("/", meRoutes(db, auth.ownerLogin));
  web.use(requireMember);
  web.use(requireOwnOrigin(auth));
  web.use(limitBody(MAX_BODY_BYTES));
  web.route("/", projectRoutes(db));
  web.route("/", issueRoutes(db, service));
  web.route("/", feedRoutes(db));
  web.route("/", searchRoutes(db));
  web.route("/", peopleRoutes(db));
  web.route("/", eventRoutes(db, bus, shutdown));
  return web;
}
