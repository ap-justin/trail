import type { Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { Db } from "../db/client.js";
import { authenticateKey } from "../service/keys.js";
import type { ApiEnv } from "./env.js";
import { errorResponse } from "./errors.js";

// a Response message keeps its own status, so a malformed header is a 401 here, not bearerAuth's 400
const unauthorized = (c: Context) =>
  errorResponse(
    c,
    401,
    "unauthorized",
    "send Authorization: Bearer <key> with a bot's unrevoked key",
  );

/** Resolves the bearer key to its bot and the key's scope, set as `actor`; anything else is a 401. */
export function bearerKey(db: Db) {
  return bearerAuth<ApiEnv>({
    verifyToken: (token, c) => {
      const actor = authenticateKey(db, token);
      if (actor) c.set("actor", actor);
      return actor !== null;
    },
    noAuthenticationHeader: { message: unauthorized },
    invalidAuthenticationHeader: { message: unauthorized },
    invalidToken: { message: unauthorized },
  });
}
