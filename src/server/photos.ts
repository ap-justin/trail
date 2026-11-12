import { Hono } from "hono";
import { every, some } from "hono/combine";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { bearerKey } from "./api/auth.js";
import { errorResponse, handleError } from "./api/errors.js";
import type { TrailAuth } from "./auth/auth.js";
import type { ViewerEnv } from "./auth/viewer.js";
import type { Db } from "./db/client.js";
import { readActorPhoto } from "./service/photos.js";

/** Throws a 401 unless the session is a person let in; a bot key is tried before it. */
const memberSession = createMiddleware<ViewerEnv>(async (c, next) => {
  const { kind } = c.var.viewer;
  if (kind !== "member" && kind !== "owner") {
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
 * `GET /api/photos/:actorId/:hash`, to any bot key or person let in. The hash
 * is the photo's own, so a URL never changes meaning and is cached for good.
 */
export function photoRoutes({ db, auth }: { db: Db; auth: TrailAuth }) {
  const photos = new Hono();
  photos.onError(handleError);
  photos.use(some(bearerKey(db), every(auth.viewer, memberSession)));
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
      "Cache-Control": "private, max-age=31536000, immutable",
      "Content-Disposition": "inline",
    });
  });
  return photos;
}
