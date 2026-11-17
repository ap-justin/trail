import { createRoute } from "@hono/zod-openapi";
import { and, desc, eq, sql } from "drizzle-orm";
import { workingNowSchema } from "../../shared/schemas.js";
import { jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import { actor, actorPhoto, issue, product } from "../db/schema.js";
import { amongProducts } from "../service/visible.js";
import { createWebRouter } from "./env.js";
import { toWebActor, visibleIds, webActorColumns } from "./visible.js";

// the strip shows a few and a "+N" from total, so the rest are never drawn
const WORKING_NOW_MAX = 12;

const workingNow = createRoute({
  method: "get",
  path: "/working-now",
  responses: {
    200: jsonContent(
      workingNowSchema,
      `Up to ${WORKING_NOW_MAX} in-progress items assigned to a bot in a visible product, most recently updated first, and how many there are in all`,
    ),
  },
});

export function workingNowRoutes(db: Db) {
  return createWebRouter().openapi(workingNow, (c) => {
    const rows = db
      .select({
        key: sql<string>`${product.key} || '-' || ${issue.number}`,
        title: issue.title,
        productKey: product.key,
        bot: webActorColumns,
        // over the whole match, before the limit
        total: sql<number>`count(*) over ()`,
      })
      .from(issue)
      .innerJoin(product, eq(product.id, issue.productId))
      .innerJoin(
        actor,
        and(eq(actor.id, issue.assigneeId), eq(actor.kind, "bot")),
      )
      .leftJoin(actorPhoto, eq(actorPhoto.actorId, actor.id))
      .where(
        and(
          amongProducts(issue.productId, visibleIds(c.var.member)),
          eq(issue.status, "in_progress"),
        ),
      )
      .orderBy(desc(issue.updatedAt), desc(issue.id))
      .limit(WORKING_NOW_MAX)
      .all();
    return c.json(
      {
        total: rows[0]?.total ?? 0,
        entries: rows.map(({ key, title, productKey, bot }) => ({
          item: { key, title },
          productKey,
          bot: toWebActor(bot),
        })),
      },
      200,
    );
  });
}
