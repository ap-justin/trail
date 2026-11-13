import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  type ApiKeyAction,
  actor,
  apiKey,
  apiKeyActions,
  apiKeyProject,
  project,
} from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import type { Tx } from "./tx.js";

export type Actor = typeof actor.$inferSelect;

/** What a key may reach; null on either side is unrestricted. */
export type KeyScope = {
  /** by id and key, A to Z by key */
  projects: { id: string; key: string }[] | null;
  /** in `apiKeyActions` order */
  actions: ApiKeyAction[] | null;
};

/** A bot as one of its keys authenticates it: the bot, and that key's scope. */
export type KeyActor = Actor & { scope: KeyScope };

/** A key's scope as a person or bot reads it: projects by key. */
export type KeyScopeView = {
  projects: string[] | null;
  actions: ApiKeyAction[] | null;
};

/** The scope to mint a key with: project keys in any case, and actions; a list left out is unrestricted. */
export type KeyScopeInput = { projects?: string[]; actions?: string[] };

export const scopeView = (scope: KeyScope): KeyScopeView => ({
  projects: scope.projects?.map((p) => p.key) ?? null,
  actions: scope.actions,
});

// trail_<8 hex prefix>_<43 base64url chars of 32 random bytes>; hex keeps `_` out of the prefix
const keyPattern = /^trail_([0-9a-f]{8})_[A-Za-z0-9_-]{43}$/;

const sha256 = (key: string) => createHash("sha256").update(key).digest();

function labelOf(raw: string): string {
  const label = raw.trim();
  if (label === "") throw new ValidationError("label must not be empty");
  return label;
}

function displayNameOf(displayName: string): string {
  const name = displayName.trim();
  if (name === "") throw new ValidationError("display name must not be empty");
  return name;
}

/** "a", "a and b", "a, b and c" */
export const andList = (items: readonly string[]) =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

function validActions(raw: string[] | undefined): ApiKeyAction[] | null {
  if (raw === undefined) return null;
  if (raw.length === 0) {
    throw new ValidationError(
      "actions must name at least one action: leave it out for a key with every action",
    );
  }
  const wanted = new Set(raw.map((a) => a.trim()));
  for (const action of wanted) {
    if (!(apiKeyActions as readonly string[]).includes(action)) {
      throw new ValidationError(
        `unknown action "${action}": a key's actions are ${andList(apiKeyActions)}`,
      );
    }
  }
  return apiKeyActions.filter((a) => wanted.has(a));
}

/** The ids of the projects with these keys; null for a list left out. */
function projectIdsOf(tx: Tx, keys: string[] | undefined): string[] | null {
  if (keys === undefined) return null;
  if (keys.length === 0) {
    throw new ValidationError(
      "projects must name at least one project: leave it out for a key that reaches every project",
    );
  }
  const wanted = [...new Set(keys.map((k) => k.trim().toUpperCase()))];
  const found = tx
    .select({ id: project.id, key: project.key })
    .from(project)
    .where(inArray(project.key, wanted))
    .all();
  const unknown = wanted.filter((k) => !found.some((p) => p.key === k));
  if (unknown.length > 0) {
    throw new ValidationError(
      `no project with key ${unknown.join(", ")}: scope the key to the keys of existing projects, like TRL`,
    );
  }
  return found.map((p) => p.id);
}

function mintKey(tx: Tx, actorId: string, scope: KeyScopeInput): string {
  const actions = validActions(scope.actions);
  const projectIds = projectIdsOf(tx, scope.projects);
  const prefix = randomBytes(4).toString("hex");
  const key = `trail_${prefix}_${randomBytes(32).toString("base64url")}`;
  const { id } = tx
    .insert(apiKey)
    .values({ actorId, prefix, hash: sha256(key).toString("hex"), actions })
    .returning({ id: apiKey.id })
    .get();
  if (projectIds !== null) {
    tx.insert(apiKeyProject)
      .values(projectIds.map((projectId) => ({ apiKeyId: id, projectId })))
      .run();
  }
  return key;
}

/**
 * Creates a bot and its key, scoped to `options.scope`. The key is returned
 * once and never stored. A bot's name (ignoring the case of A-Z), and its
 * label when it has one, are unique among bots.
 */
export function createBot(
  db: Db,
  displayName: string,
  options: { label?: string; scope?: KeyScopeInput } = {},
): { actor: Actor; key: string } {
  const name = displayNameOf(displayName);
  const label = options.label === undefined ? null : labelOf(options.label);
  return db.transaction(
    (tx) => {
      const twin = tx
        .select()
        .from(actor)
        .where(
          and(
            eq(actor.kind, "bot"),
            sql`lower(${actor.displayName}) = lower(${name})`,
          ),
        )
        .get();
      if (twin) {
        throw new ConflictError(
          `a bot named "${twin.displayName}" already exists (${twin.id}), and bot names match ignoring the case of A-Z: pick another name than "${name}", or mint that bot another key with \`trail key create ${twin.label ?? twin.id}\``,
        );
      }
      if (label !== null) {
        const holder = tx
          .select()
          .from(actor)
          .where(and(eq(actor.kind, "bot"), eq(actor.label, label)))
          .get();
        if (holder) {
          throw new ConflictError(
            `label "${label}" is already on bot "${holder.displayName}" (${holder.id}): one label names one bot, so mint that bot another key with \`trail key create ${label}\``,
          );
        }
      }
      const created = tx
        .insert(actor)
        .values({ kind: "bot", displayName: name, label })
        .returning()
        .get();
      return {
        actor: created,
        key: mintKey(tx, created.id, options.scope ?? {}),
      };
    },
    { behavior: "immediate" },
  );
}

/** The one bot whose label is `ref` or whose name is `ref` ignoring the case of A-Z; two is ambiguous. */
function onlyBotByLabelOrName(tx: Tx, ref: string): Actor | undefined {
  const matches = tx
    .select()
    .from(actor)
    .where(
      and(
        eq(actor.kind, "bot"),
        or(
          eq(actor.label, ref),
          sql`lower(${actor.displayName}) = lower(${ref})`,
        ),
      ),
    )
    .all();
  if (matches.length > 1) {
    throw new ConflictError(
      `"${ref}" matches more than one bot (${matches.map((m) => m.id).join(", ")}): use a bot's id`,
    );
  }
  return matches[0];
}

/**
 * Sets a bot's display name. `botRef` is its actor id, label or current name
 * (names match ignoring the case of A-Z); an id wins outright, and a label or
 * name matching two bots is ambiguous and refused. A bot may take its own name
 * in another case. People are refused: their names come from their sign-in.
 */
export function renameBot(
  db: Db,
  botRef: string,
  newName: string,
): { id: string; oldName: string; newName: string } {
  const name = displayNameOf(newName);
  return db.transaction(
    (tx) => {
      const bot =
        tx.select().from(actor).where(eq(actor.id, botRef)).get() ??
        onlyBotByLabelOrName(tx, botRef);
      if (!bot) {
        throw new NotFoundError(
          `no bot with id, label or name ${botRef}: \`trail key list\` shows each bot's id, name and label`,
        );
      }
      if (bot.kind !== "bot") {
        throw new ConflictError(
          `${bot.id} is a person, not a bot: people's names come from their sign-in`,
        );
      }
      const twin = tx
        .select()
        .from(actor)
        .where(
          and(
            eq(actor.kind, "bot"),
            sql`lower(${actor.displayName}) = lower(${name})`,
          ),
        )
        .get();
      if (twin && twin.id !== bot.id) {
        throw new ConflictError(
          `a bot named "${twin.displayName}" already exists (${twin.id}), and bot names match ignoring the case of A-Z: pick another name than "${name}"`,
        );
      }
      tx.update(actor)
        .set({ displayName: name })
        .where(eq(actor.id, bot.id))
        .run();
      return { id: bot.id, oldName: bot.displayName, newName: name };
    },
    { behavior: "immediate" },
  );
}

/** Mints another key, scoped to `scope`, for the bot with this actor id or label. */
export function createKey(
  db: Db,
  botRef: string,
  scope: KeyScopeInput = {},
): { actor: Actor; key: string } {
  return db.transaction(
    (tx) => {
      const bot = tx
        .select()
        .from(actor)
        .where(
          and(
            eq(actor.kind, "bot"),
            or(eq(actor.id, botRef), eq(actor.label, botRef)),
          ),
        )
        .get();
      if (!bot) {
        throw new NotFoundError(
          `no bot with id or label ${botRef}: \`trail key list\` shows each bot's id and label`,
        );
      }
      return { actor: bot, key: mintKey(tx, bot.id, scope) };
    },
    { behavior: "immediate" },
  );
}

export type KeyListing = {
  prefix: string;
  actorId: string;
  displayName: string;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  scope: KeyScopeView;
};

/** The projects each of these keys is limited to, by key id; a key with none is absent. */
function allowlists(
  db: Db,
  keyIds: string[],
): Map<string, { id: string; key: string }[]> {
  const rows =
    keyIds.length === 0
      ? []
      : db
          .select({
            keyId: apiKeyProject.apiKeyId,
            id: project.id,
            key: project.key,
          })
          .from(apiKeyProject)
          .innerJoin(project, eq(project.id, apiKeyProject.projectId))
          .where(inArray(apiKeyProject.apiKeyId, keyIds))
          .orderBy(asc(project.key))
          .all();
  const byKey = new Map<string, { id: string; key: string }[]>();
  for (const { keyId, id, key } of rows) {
    byKey.set(keyId, [...(byKey.get(keyId) ?? []), { id, key }]);
  }
  return byKey;
}

/** Every key, oldest first, with its scope and without its hash. */
export function listKeys(db: Db): KeyListing[] {
  const rows = db
    .select({
      id: apiKey.id,
      actions: apiKey.actions,
      prefix: apiKey.prefix,
      actorId: apiKey.actorId,
      displayName: actor.displayName,
      label: actor.label,
      createdAt: apiKey.createdAt,
      revokedAt: apiKey.revokedAt,
    })
    .from(apiKey)
    .innerJoin(actor, eq(actor.id, apiKey.actorId))
    .orderBy(asc(apiKey.createdAt), asc(apiKey.id))
    .all();
  const lists = allowlists(
    db,
    rows.map((r) => r.id),
  );
  return rows.map(({ id, actions, ...listing }) => ({
    ...listing,
    scope: scopeView({ projects: lists.get(id) ?? null, actions }),
  }));
}

export function createHuman(
  db: Db,
  input: { displayName: string; githubId?: number },
): Actor {
  return db
    .insert(actor)
    .values({
      kind: "human",
      displayName: displayNameOf(input.displayName),
      githubId: input.githubId,
    })
    .returning()
    .get();
}

/** Revokes the key with this prefix; revoking a revoked key keeps its first `revokedAt`. */
export function revokeKey(
  db: Db,
  prefix: string,
): { prefix: string; actorId: string; revokedAt: Date } {
  return db.transaction(
    (tx) => {
      const key = tx
        .select()
        .from(apiKey)
        .where(eq(apiKey.prefix, prefix))
        .get();
      if (!key) throw new NotFoundError(`no key with prefix ${prefix}`);
      const revokedAt = key.revokedAt ?? new Date();
      if (!key.revokedAt) {
        tx.update(apiKey).set({ revokedAt }).where(eq(apiKey.id, key.id)).run();
      }
      return { prefix, actorId: key.actorId, revokedAt };
    },
    { behavior: "immediate" },
  );
}

function verifiedKey(db: Db, token: string) {
  const prefix = keyPattern.exec(token)?.[1];
  if (prefix === undefined) return null;
  const row = db
    .select({
      actor,
      id: apiKey.id,
      actions: apiKey.actions,
      hash: apiKey.hash,
      revokedAt: apiKey.revokedAt,
    })
    .from(apiKey)
    .innerJoin(actor, eq(actor.id, apiKey.actorId))
    .where(eq(apiKey.prefix, prefix))
    .get();
  if (!row || row.revokedAt) return null;
  return timingSafeEqual(sha256(token), Buffer.from(row.hash, "hex"))
    ? row
    : null;
}

/** The bot a bearer token belongs to, or null when it is malformed, unknown or revoked. */
export function resolveKey(db: Db, token: string): Actor | null {
  return verifiedKey(db, token)?.actor ?? null;
}

/** `resolveKey` with the scope of the key the token is. */
export function authenticateKey(db: Db, token: string): KeyActor | null {
  const row = verifiedKey(db, token);
  if (!row) return null;
  return {
    ...row.actor,
    scope: {
      projects: allowlists(db, [row.id]).get(row.id) ?? null,
      actions: row.actions,
    },
  };
}
