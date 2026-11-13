import { createMiddleware } from "hono/factory";
import { createRouter } from "../api/env.js";
import { errorResponse } from "../api/errors.js";
import type { TrailAuth } from "../auth/auth.js";
import type { Viewer } from "../auth/viewer.js";

/** A viewer let in: the owner, or a member with its invite's projects. */
export type Member = Extract<Viewer, { kind: "member" | "owner" }>;

export type WebEnv = { Variables: { viewer: Viewer; member: Member } };

export const createWebRouter = () => createRouter<WebEnv>();

/** 401 without a session, 403 not_invited for an account or address not on the list; sets `member`. */
export const requireMember = createMiddleware<WebEnv>(async (c, next) => {
  const viewer = c.var.viewer;
  if (viewer.kind === "anonymous") {
    return errorResponse(
      c,
      401,
      "unauthorized",
      "sign in with GitHub or email",
    );
  }
  if (viewer.kind === "not_invited") {
    const who = viewer.login === null ? viewer.email : `@${viewer.login}`;
    return errorResponse(
      c,
      403,
      "not_invited",
      `${who} is not invited: ask the owner to invite your GitHub username or email address, then sign in again`,
    );
  }
  c.set("member", viewer);
  await next();
});

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuses a write whose Origin is missing or not the app's own: the session
 * cookie rides along on any cross-site request, so it alone proves nothing.
 */
export const requireOwnOrigin = (auth: TrailAuth) =>
  createMiddleware<WebEnv>(async (c, next) => {
    if (
      !safeMethods.has(c.req.method) &&
      !(await auth.isTrustedOrigin(c.req.raw))
    ) {
      return errorResponse(
        c,
        403,
        "bad_origin",
        "send the request from trail's own pages: its Origin header is missing or another site's",
      );
    }
    await next();
  });
