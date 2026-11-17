import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { WebActorView } from "../../shared/schemas.js";
import type { VisibleProduct } from "../auth/viewer.js";
import type { Db } from "../db/client.js";
import {
  activityEvent,
  actor,
  actorPhoto,
  project,
  projectProduct,
} from "../db/schema.js";
import { NotFoundError } from "../service/errors.js";
import type { ActingActor } from "../service/index.js";
import { photoUrl } from "../service/photos.js";
import type { Member } from "./env.js";

/** The visible product with this key, in any case; a hidden one is the same 404 as a missing one. */
export function visibleProduct(member: Member, key: string): VisibleProduct {
  const found = member.products.find((p) => p.key === key.toUpperCase());
  if (!found) throw new NotFoundError(`no product ${key}`);
  return found;
}

export const visibleIds = (member: Member) => member.products.map((p) => p.id);

/**
 * The member as the service acts for them: the owner unrestricted, a member
 * scoped to their products, so the service's visibility rules are theirs too.
 */
export const actingAs = (member: Member): ActingActor => ({
  id: member.actor.id,
  kind: "human",
  ...(member.kind === "member" && {
    scope: {
      products: member.products.map(({ id, key }) => ({ id, key })),
      // people are invited by product, never by project
      projects: [],
      actions: null,
    },
  }),
});

/** The ids of the projects drawing from at least one of these products, as a subquery. */
export const projectIdsAmong = (db: Db, productIds: string[]) =>
  db
    .selectDistinct({ id: projectProduct.projectId })
    .from(projectProduct)
    .where(inArray(projectProduct.productId, productIds));

/** The project with exactly this slug, if it draws from a product the member sees; else the 404 an unknown slug gets. */
export function visibleProject(db: Db, member: Member, slug: string) {
  const found = db
    .select()
    .from(project)
    .where(
      and(
        eq(project.slug, slug),
        inArray(project.id, projectIdsAmong(db, visibleIds(member))),
      ),
    )
    .get();
  if (!found) throw new NotFoundError(`no project ${slug}`);
  return found;
}

/**
 * The events a viewer of these products sees: those of a visible product, and
 * a project's own (no product) when the project draws from a visible product.
 */
export const visibleEvents = (db: Db, productIds: string[]): SQL =>
  or(
    inArray(activityEvent.productId, productIds),
    and(
      isNull(activityEvent.productId),
      inArray(activityEvent.projectId, projectIdsAmong(db, productIds)),
    ),
  ) as SQL;

/** An actor's columns as the web shows them, its photo's hash and never its bytes: actor left-joined to actor_photo; map with `toWebActor`. */
export const webActorColumns = {
  id: actor.id,
  name: actor.displayName,
  kind: actor.kind,
  title: actor.title,
  photoHash: actorPhoto.hash,
};

/** Actors as the web shows them, each with its photo's hash and never its bytes; map rows with `toWebActor`. */
export const selectWebActors = (db: Db) =>
  db
    .select(webActorColumns)
    .from(actor)
    .leftJoin(actorPhoto, eq(actorPhoto.actorId, actor.id));

export const toWebActor = ({
  photoHash,
  ...row
}: Omit<WebActorView, "photoUrl"> & {
  photoHash: string | null;
}): WebActorView => ({ ...row, photoUrl: photoUrl(row.id, photoHash) });

/** The actors with these ids, by id; actors are never deleted, so every id is there. */
export function actorsById(
  db: Db,
  ids: (string | null)[],
): (id: string) => WebActorView {
  const wanted = [...new Set(ids.filter((id) => id !== null))];
  const rows =
    wanted.length === 0
      ? []
      : selectWebActors(db).where(inArray(actor.id, wanted)).all();
  const byId = new Map(rows.map((r) => [r.id, toWebActor(r)]));
  return (id) => byId.get(id) as WebActorView;
}
