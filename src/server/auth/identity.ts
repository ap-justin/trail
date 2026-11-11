import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { actor, invite, project, projectMember } from "../db/schema.js";

export type HumanActor = {
  id: string;
  displayName: string;
  githubId: number;
  githubLogin: string;
};

export type VisibleProject = { id: string; key: string; name: string };

/** What a sign-in knows of a GitHub account; `login` is lowercased. */
export type GitHubIdentity = { githubId: number; login: string; name: string };

/**
 * Finds the human actor for a GitHub account by id, refreshing its login, and
 * creates it when the account is the owner or invited. Returns the actor only
 * while the account is let in; a renamed account answers to its new login.
 */
export function syncActor(
  db: Db,
  identity: GitHubIdentity,
  ownerLogin: string,
): { actor: HumanActor; isOwner: boolean } | null {
  const { githubId, login } = identity;
  const isOwner = login === ownerLogin;
  return db.transaction((tx) => {
    const letIn =
      isOwner ||
      tx.select().from(invite).where(eq(invite.username, login)).get() !==
        undefined;
    const found = tx
      .select()
      .from(actor)
      .where(and(eq(actor.githubId, githubId), eq(actor.kind, "human")))
      .get();
    if (!found && !letIn) return null;
    if (found?.githubLogin !== login) {
      // GitHub logins are unique at any moment: an actor still holding this one has since renamed
      tx.update(actor)
        .set({ githubLogin: null })
        .where(
          found
            ? and(eq(actor.githubLogin, login), ne(actor.id, found.id))
            : eq(actor.githubLogin, login),
        )
        .run();
    }
    let row = found;
    if (!row) {
      row = tx
        .insert(actor)
        .values({
          kind: "human",
          displayName: identity.name.trim() || login,
          githubId,
          githubLogin: login,
        })
        .returning()
        .get();
    } else if (row.githubLogin !== login) {
      row = tx
        .update(actor)
        .set({ githubLogin: login })
        .where(eq(actor.id, row.id))
        .returning()
        .get();
    }
    if (!letIn) return null;
    return {
      actor: {
        id: row.id,
        displayName: row.displayName,
        githubId,
        githubLogin: login,
      },
      isOwner,
    };
  });
}

/** Every project for the owner; for anyone else, the projects their invite lists. */
export function visibleProjects(
  db: Db,
  login: string,
  isOwner: boolean,
): VisibleProject[] {
  const columns = { id: project.id, key: project.key, name: project.name };
  if (isOwner) {
    return db.select(columns).from(project).orderBy(asc(project.key)).all();
  }
  return db
    .select(columns)
    .from(projectMember)
    .innerJoin(project, eq(project.id, projectMember.projectId))
    .where(eq(projectMember.username, login))
    .orderBy(asc(project.key))
    .all();
}
