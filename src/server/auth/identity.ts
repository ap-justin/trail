import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { actor, invite, project, projectMember } from "../db/schema.js";
import type { Tx } from "../service/tx.js";

export type HumanActor = {
  id: string;
  displayName: string;
  githubId: number;
  githubLogin: string;
};

export type VisibleProject = { id: string; key: string; name: string };

/** What a sign-in knows of a GitHub account; `login` is lowercased. */
export type GitHubIdentity = { githubId: number; login: string; name: string };

/** A let-in account: the owner, or a member through the invite it claimed. */
export type Access =
  | { actor: HumanActor; isOwner: true }
  | { actor: HumanActor; isOwner: false; inviteUsername: string };

type ActorRow = typeof actor.$inferSelect;

const isUniqueViolation = (e: unknown) =>
  (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";

/**
 * Who a GitHub account is to trail, by its numeric id: GitHub frees a login on
 * rename, so a login only ever claims access once. The first account to sign in
 * as `ownerLogin` becomes the owner; the first to sign in under an invite's
 * username binds that invite. Later, a different account with the same login
 * gets neither. Creates the account's actor once it is let in and keeps its
 * login current; returns null while the account is not let in.
 *
 * Sign-in only: `identity` must be the GitHub profile that sign-in fetched. A
 * login stored earlier may since have been freed and taken by someone else.
 */
export function syncActor(
  db: Db,
  identity: GitHubIdentity,
  ownerLogin: string,
): Access | null {
  const { githubId, login } = identity;
  // immediate: the claims below read then write, and two sign-ins must not both claim
  return db.transaction(
    (tx): Access | null => {
      const row = tx
        .select()
        .from(actor)
        .where(and(eq(actor.githubId, githubId), eq(actor.kind, "human")))
        .get();
      // the account's actor, created on its first let-in sign-in, under its current login
      let human: HumanActor | undefined;
      const letIn = () => {
        human ??= row ? refresh(tx, row, login) : insert(tx, identity);
        return human;
      };
      if (row?.isOwner) return { actor: letIn(), isOwner: true };

      const bound = tx
        .select()
        .from(invite)
        .where(eq(invite.githubId, githubId))
        .get();
      if (bound) {
        return {
          actor: letIn(),
          isOwner: false,
          inviteUsername: bound.username,
        };
      }

      const ownerUnclaimed =
        login === ownerLogin &&
        !tx.select().from(actor).where(eq(actor.isOwner, true)).get();
      if (ownerUnclaimed && claimOwner(tx, letIn().id)) {
        return { actor: letIn(), isOwner: true };
      }

      if (claimInvite(tx, login, githubId)) {
        return { actor: letIn(), isOwner: false, inviteUsername: login };
      }

      // not let in: no actor is made, and a known one only has its login kept current
      if (row && !human) refresh(tx, row, login);
      return null;
    },
    { behavior: "immediate" },
  );
}

/**
 * The access a GitHub account already holds, by its id alone: the owner seat
 * or an invite its sign-in claimed. Reads only, so every signed-in request stays
 * off SQLite's single write lock and claims nothing; `login` is the one shown.
 */
export function accessOf(
  db: Db,
  githubId: number,
  login: string,
): Access | null {
  const row = db
    .select()
    .from(actor)
    .where(and(eq(actor.githubId, githubId), eq(actor.kind, "human")))
    .get();
  if (!row) return null;
  if (row.isOwner) return { actor: humanActor(row, login), isOwner: true };
  const bound = db
    .select()
    .from(invite)
    .where(eq(invite.githubId, githubId))
    .get();
  if (!bound) return null;
  return {
    actor: humanActor(row, login),
    isOwner: false,
    inviteUsername: bound.username,
  };
}

function claimOwner(tx: Tx, actorId: string): boolean {
  try {
    const { changes } = tx
      .update(actor)
      .set({ isOwner: true })
      .where(
        and(
          eq(actor.id, actorId),
          sql`not exists (select 1 from ${actor} where ${actor.isOwner} = 1)`,
        ),
      )
      .run();
    return changes === 1;
  } catch (e) {
    // actor_owner_unique: another account claimed it first
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

function claimInvite(tx: Tx, username: string, githubId: number): boolean {
  try {
    const { changes } = tx
      .update(invite)
      .set({ githubId })
      .where(and(eq(invite.username, username), isNull(invite.githubId)))
      .run();
    return changes === 1;
  } catch (e) {
    // invite_github_id_unique: this account already holds another invite
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

/** Takes `login` from any actor still holding it: GitHub logins are unique at any moment. */
function releaseLogin(tx: Tx, login: string, keep?: string) {
  tx.update(actor)
    .set({ githubLogin: null })
    .where(
      keep
        ? and(eq(actor.githubLogin, login), ne(actor.id, keep))
        : eq(actor.githubLogin, login),
    )
    .run();
}

function refresh(tx: Tx, row: ActorRow, login: string): HumanActor {
  if (row.githubLogin !== login) {
    releaseLogin(tx, login, row.id);
    tx.update(actor)
      .set({ githubLogin: login })
      .where(eq(actor.id, row.id))
      .run();
  }
  return humanActor(row, login);
}

function insert(tx: Tx, identity: GitHubIdentity): HumanActor {
  releaseLogin(tx, identity.login);
  const row = tx
    .insert(actor)
    .values({
      kind: "human",
      displayName: identity.name.trim() || identity.login,
      githubId: identity.githubId,
      githubLogin: identity.login,
    })
    .returning()
    .get();
  return humanActor(row, identity.login);
}

const humanActor = (row: ActorRow, login: string): HumanActor => ({
  id: row.id,
  displayName: row.displayName,
  githubId: row.githubId as number,
  githubLogin: login,
});

/** Every project for the owner; for a member, those listed under the invite it claimed. */
export function visibleProjects(db: Db, access: Access): VisibleProject[] {
  const columns = { id: project.id, key: project.key, name: project.name };
  if (access.isOwner) {
    return db.select(columns).from(project).orderBy(asc(project.key)).all();
  }
  return db
    .select(columns)
    .from(projectMember)
    .innerJoin(project, eq(project.id, projectMember.projectId))
    .where(eq(projectMember.username, access.inviteUsername))
    .orderBy(asc(project.key))
    .all();
}
