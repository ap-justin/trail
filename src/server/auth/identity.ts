import { and, asc, eq, isNull, ne, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { actor, invite, project, projectMember } from "../db/schema.js";
import type { Tx } from "../service/tx.js";

/** A person who signs in with GitHub; `githubLogin` is lowercased. */
export type GitHubHuman = {
  id: string;
  displayName: string;
  githubId: number;
  githubLogin: string;
};

/** A person let in by email, who has no GitHub account in trail; `email` is lowercased. */
export type EmailHuman = {
  id: string;
  displayName: string;
  githubId: null;
  githubLogin: null;
  email: string;
};

/** A person, told apart by `githubId`: null for an email person. */
export type HumanActor = GitHubHuman | EmailHuman;

export type VisibleProject = { id: string; key: string; name: string };

/** What a sign-in knows of a GitHub account; `login` is lowercased. */
export type GitHubIdentity = { githubId: number; login: string; name: string };

/** A member let in through `inviteId`: the invite its GitHub account claimed, or its email's. */
export type MemberAccess<A extends HumanActor = HumanActor> = {
  actor: A;
  isOwner: false;
  inviteId: number;
};

/** What a GitHub account holds: the owner seat, which only GitHub signs into, or an invite. */
export type GitHubAccess =
  | { actor: GitHubHuman; isOwner: true }
  | MemberAccess<GitHubHuman>;

/** A let-in person: the owner, or a member through its invite. */
export type Access = GitHubAccess | MemberAccess<EmailHuman>;

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
): GitHubAccess | null {
  const { githubId, login } = identity;
  // immediate: the claims below read then write, and two sign-ins must not both claim
  return db.transaction(
    (tx): GitHubAccess | null => {
      const row = tx
        .select()
        .from(actor)
        .where(and(eq(actor.githubId, githubId), eq(actor.kind, "human")))
        .get();
      // the account's actor, created on its first let-in sign-in, under its current login
      let human: GitHubHuman | undefined;
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
        return { actor: letIn(), isOwner: false, inviteId: bound.id };
      }

      const ownerUnclaimed =
        login === ownerLogin &&
        !tx.select().from(actor).where(eq(actor.isOwner, true)).get();
      if (ownerUnclaimed && claimOwner(tx, letIn().id)) {
        return { actor: letIn(), isOwner: true };
      }

      const claimed = claimInvite(tx, login, githubId);
      if (claimed !== null) {
        return { actor: letIn(), isOwner: false, inviteId: claimed };
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
): GitHubAccess | null {
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
  return { actor: humanActor(row, login), isOwner: false, inviteId: bound.id };
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Whether an email invite names `email`: the only addresses a sign-in link is sent to. */
export const isEmailInvited = (db: Db, email: string): boolean =>
  db
    .select({ id: invite.id })
    .from(invite)
    .where(eq(invite.email, normalizeEmail(email)))
    .get() !== undefined;

/**
 * Who a verified email address is to trail: a member through its email
 * invite, or null without one. Creates the person's actor on its first let-in,
 * named for the part before the @; a removed and re-made invite finds the same
 * actor again.
 *
 * Sign-in only: `verifiedEmail` must be an address the sign-in just proved the
 * person holds.
 */
export function syncEmailActor(
  db: Db,
  verifiedEmail: string,
): MemberAccess<EmailHuman> | null {
  const email = normalizeEmail(verifiedEmail);
  // immediate: two sign-ins for one address must not both create its actor
  return db.transaction(
    (tx) => {
      const bound = tx
        .select()
        .from(invite)
        .where(eq(invite.email, email))
        .get();
      if (!bound) return null;
      const row =
        tx.select().from(actor).where(eq(actor.email, email)).get() ??
        tx
          .insert(actor)
          .values({
            kind: "human",
            displayName: email.slice(0, email.indexOf("@")),
            email,
          })
          .returning()
          .get();
      return { actor: emailHuman(row), isOwner: false, inviteId: bound.id };
    },
    { behavior: "immediate" },
  );
}

/**
 * The access an email person already holds: its invite, once a sign-in has
 * let it in. Reads only, like `accessOf`, so a removed invite shuts the person
 * out on its next request.
 */
export function accessOfEmail(
  db: Db,
  email: string,
): MemberAccess<EmailHuman> | null {
  const found = db
    .select({ actor, inviteId: invite.id })
    .from(actor)
    .innerJoin(invite, eq(invite.email, actor.email))
    .where(eq(actor.email, normalizeEmail(email)))
    .get();
  if (!found) return null;
  return {
    actor: emailHuman(found.actor),
    isOwner: false,
    inviteId: found.inviteId,
  };
}

/** The invite `person` is let in through, if it still exists: by GitHub id, or by email. */
export const inviteOf = (person: HumanActor): SQL =>
  person.githubId === null
    ? eq(invite.email, person.email)
    : eq(invite.githubId, person.githubId);

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

/** Binds `username`'s pending invite to `githubId` and returns its id; null when there was none to claim. */
function claimInvite(
  tx: Tx,
  username: string,
  githubId: number,
): number | null {
  try {
    const claimed = tx
      .update(invite)
      .set({ githubId })
      .where(and(eq(invite.username, username), isNull(invite.githubId)))
      .returning({ id: invite.id })
      .get();
    return claimed?.id ?? null;
  } catch (e) {
    // invite_github_id_unique: this account already holds another invite
    if (isUniqueViolation(e)) return null;
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

function refresh(tx: Tx, row: ActorRow, login: string): GitHubHuman {
  if (row.githubLogin !== login) {
    releaseLogin(tx, login, row.id);
    tx.update(actor)
      .set({ githubLogin: login })
      .where(eq(actor.id, row.id))
      .run();
  }
  return humanActor(row, login);
}

function insert(tx: Tx, identity: GitHubIdentity): GitHubHuman {
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

const humanActor = (row: ActorRow, login: string): GitHubHuman => ({
  id: row.id,
  displayName: row.displayName,
  githubId: row.githubId as number,
  githubLogin: login,
});

const emailHuman = (row: ActorRow): EmailHuman => ({
  id: row.id,
  displayName: row.displayName,
  githubId: null,
  githubLogin: null,
  email: row.email as string,
});

/** Every project for the owner; for a member, those listed under its invite. */
export function visibleProjects(db: Db, access: Access): VisibleProject[] {
  const columns = { id: project.id, key: project.key, name: project.name };
  if (access.isOwner) {
    return db.select(columns).from(project).orderBy(asc(project.key)).all();
  }
  return db
    .select(columns)
    .from(projectMember)
    .innerJoin(project, eq(project.id, projectMember.projectId))
    .where(eq(projectMember.inviteId, access.inviteId))
    .orderBy(asc(project.key))
    .all();
}
