import { eq, inArray } from "drizzle-orm";
import type { WebActorView } from "../../shared/schemas.js";
import type { VisibleProject } from "../auth/viewer.js";
import type { Db } from "../db/client.js";
import { actor, actorPhoto } from "../db/schema.js";
import { photoUrl } from "../service/photos.js";
import { noProject } from "../service/visible.js";
import type { Member } from "./env.js";

/** The visible project with this key, in any case. */
export function visibleProject(member: Member, key: string): VisibleProject {
  const found = member.projects.find((p) => p.key === key.toUpperCase());
  if (!found) throw noProject(key);
  return found;
}

export const visibleIds = (member: Member) => member.projects.map((p) => p.id);

/** Actors as the web shows them, each with its photo's hash and never its bytes; map rows with `toWebActor`. */
export const selectWebActors = (db: Db) =>
  db
    .select({
      id: actor.id,
      name: actor.displayName,
      kind: actor.kind,
      photoHash: actorPhoto.hash,
    })
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
