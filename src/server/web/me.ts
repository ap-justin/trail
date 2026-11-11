import { createRoute } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { type MeView, meSchema } from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import type { Viewer } from "../auth/viewer.js";
import type { Db } from "../db/client.js";
import { actor } from "../db/schema.js";
import { createWebRouter } from "./env.js";

const getMe = createRoute({
  method: "get",
  path: "/me",
  responses: { 200: jsonContent(meSchema, "Who is signed in") },
});

/** The owner actor's name, or its GitHub login until it has signed in. */
export function ownerName(db: Db, ownerLogin: string): string {
  const row = db
    .select({ name: actor.displayName })
    .from(actor)
    .where(and(eq(actor.kind, "human"), eq(actor.githubLogin, ownerLogin)))
    .get();
  return row?.name ?? ownerLogin;
}

function meOf(viewer: Viewer, owner: string): MeView {
  if (viewer.kind === "anonymous" || viewer.kind === "not_invited") {
    return {
      state: viewer.kind,
      login: viewer.kind === "anonymous" ? null : viewer.login,
      actor: null,
      projects: [],
      ownerName: owner,
    };
  }
  return {
    state: viewer.kind,
    login: viewer.login,
    actor: {
      id: viewer.actor.id,
      name: viewer.actor.displayName,
      kind: "human",
    },
    projects: viewer.projects.map(({ key, name }) => ({ key, name })),
    ownerName: owner,
  };
}

/** `GET /me`, which answers every viewer, signed in or not. */
export function meRoutes(db: Db, ownerLogin: string) {
  return createWebRouter().openapi(getMe, (c) =>
    c.json(meOf(c.var.viewer, ownerName(db, ownerLogin)), 200),
  );
}
