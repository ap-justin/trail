import { inArray } from "drizzle-orm";
import type { WebActorView } from "../../shared/schemas.js";
import type { VisibleProject } from "../auth/viewer.js";
import type { Db } from "../db/client.js";
import { actor } from "../db/schema.js";
import { noProject } from "../service/visible.js";
import type { Member } from "./env.js";

/** The visible project with this key, in any case. */
export function visibleProject(member: Member, key: string): VisibleProject {
  const found = member.projects.find((p) => p.key === key.toUpperCase());
  if (!found) throw noProject(key);
  return found;
}

export const visibleIds = (member: Member) => member.projects.map((p) => p.id);

/** The actors with these ids, by id; actors are never deleted, so every id is there. */
export function actorsById(
  db: Db,
  ids: (string | null)[],
): (id: string) => WebActorView {
  const wanted = [...new Set(ids.filter((id) => id !== null))];
  const rows =
    wanted.length === 0
      ? []
      : db
          .select({ id: actor.id, name: actor.displayName, kind: actor.kind })
          .from(actor)
          .where(inArray(actor.id, wanted))
          .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (id) => byId.get(id) as WebActorView;
}
