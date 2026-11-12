import { createRoute, z } from "@hono/zod-openapi";
import { Hono } from "hono";
import { some } from "hono/combine";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { errorSchema } from "../shared/schemas.js";
import { bearerKey } from "./api/auth.js";
import { errorResponse, handleError } from "./api/errors.js";
import { jsonContent } from "./api/routes.js";
import type { TrailAuth } from "./auth/auth.js";
import type { Db } from "./db/client.js";
import { actorPhotoContentTypes } from "./db/schema.js";
import { readActorPhoto } from "./service/photos.js";

/**
 * Throws a 401 unless the session is a person let in; a bot key is tried before it.
 * The session is read without refreshing it, so a page of avatars never extends
 * the session or sets a cookie (an expired session's row is still cleaned up).
 */
const memberSession = (auth: TrailAuth) =>
  createMiddleware(async (c, next) => {
    if (!(await auth.isLetIn(c.req.raw.headers))) {
      throw new HTTPException(401, {
        res: errorResponse(
          c,
          401,
          "unauthorized",
          "send Authorization: Bearer <key> with a bot's unrevoked key, or sign in to trail as an invited person",
        ),
      });
    }
    await next();
  });

/**
 * The serving route as the /api/v1 document lists it. It is served outside
 * /api/v1, so the operation names its own server; `photoRoutes` below serves it.
 */
export const servePhotoRoute = createRoute({
  method: "get",
  path: "/photos/{actorId}/{hash}",
  servers: [{ url: "/api" }],
  summary: "Fetch an actor's photo",
  description:
    "The path an actor's photoUrl holds, under /api rather than /api/v1. Answers the image's raw bytes with its type; a URL never changes meaning, so a client may cache it for good. A bot key works, and so does a signed-in person's session.",
  tags: ["actors"],
  request: {
    params: z.object({
      actorId: z.string().describe("The actor's id, as photoUrl holds it"),
      hash: z.string().describe("The photo's hash, as photoUrl holds it"),
    }),
  },
  responses: {
    200: {
      description: "The photo's bytes",
      content: Object.fromEntries(
        actorPhotoContentTypes.map((type) => [type, {}]),
      ),
    },
    401: jsonContent(
      errorSchema,
      "No unrevoked bot key and no signed-in invited person",
    ),
    404: jsonContent(
      errorSchema,
      "The actor has no photo, or it has changed since this URL was read: read photoUrl again",
    ),
  },
});

/**
 * `GET /api/photos/:actorId/:hash`, to any bot key or person let in. The hash
 * is the photo's own, so a URL never changes meaning and is cached for good.
 */
export function photoRoutes({ db, auth }: { db: Db; auth: TrailAuth }) {
  const photos = new Hono();
  photos.onError(handleError);
  photos.use(some(bearerKey(db), memberSession(auth)));
  photos.get("/:actorId/:hash", (c) => {
    const found = readActorPhoto(
      db,
      c.req.param("actorId"),
      c.req.param("hash"),
    );
    if (!found) {
      return errorResponse(
        c,
        404,
        "not_found",
        "no photo at this URL: the actor has none, or it has changed since. Read the actor's photoUrl again for the current one.",
      );
    }
    return c.body(new Uint8Array(found.content), 200, {
      "Content-Type": found.contentType,
      "X-Content-Type-Options": "nosniff",
      // a photo URL opened directly runs nothing, whatever its bytes turn out to be
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
    });
  });
  return photos;
}
