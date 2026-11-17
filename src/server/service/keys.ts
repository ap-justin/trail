import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  type ApiKeyAction,
  actor,
  apiKey,
  apiKeyActions,
  apiKeyProduct,
  apiKeyProject,
  product,
  project,
} from "../db/schema.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import type { Tx } from "./tx.js";
import { validBotTitle } from "./validate.js";

export type Actor = typeof actor.$inferSelect;

/**
 * What a key may reach. `products` is null only on an unrestricted key, one
 * with neither products nor projects; a key limited to projects alone has
 * `products: []`. `actions` null is every action.
 */
export type KeyScope = {
  /** by id and key, A to Z by key */
  products: { id: string; key: string }[] | null;
  /** by id and slug, A to Z by slug; empty for none */
  projects: { id: string; slug: string }[];
  /** in `apiKeyActions` order */
  actions: ApiKeyAction[] | null;
};

/** A bot as one of its keys authenticates it: the bot, and that key's scope. */
export type KeyActor = Actor & { scope: KeyScope };

/** A key's scope as a person or bot reads it: products by key, projects by slug, both null on an unrestricted key. */
export type KeyScopeView = {
  products: string[] | null;
  projects: string[] | null;
  actions: ApiKeyAction[] | null;
};

/**
 * The scope to mint a key with: product keys in any case, project slugs and
 * actions. Products and projects both left out is a key that reaches
 * everything; actions left out is every action.
 */
export type KeyScopeInput = {
  products?: string[];
  projects?: string[];
  actions?: string[];
};

export const scopeView = (scope: KeyScope): KeyScopeView =>
  scope.products === null
    ? { products: null, projects: null, actions: scope.actions }
    : {
        products: scope.products.map((p) => p.key),
        projects: scope.projects.map((p) => p.slug),
        actions: scope.actions,
      };

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

/** The ids of the products with these keys; null for a list left out. */
function productIdsOf(tx: Tx, keys: string[] | undefined): string[] | null {
  if (keys === undefined) return null;
  if (keys.length === 0) {
    throw new ValidationError(
      "products must name at least one product: leave it out for a key that reaches every product",
    );
  }
  const wanted = [...new Set(keys.map((k) => k.trim().toUpperCase()))];
  const found = tx
    .select({ id: product.id, key: product.key })
    .from(product)
    .where(inArray(product.key, wanted))
    .all();
  const unknown = wanted.filter((k) => !found.some((p) => p.key === k));
  if (unknown.length > 0) {
    const existing = tx
      .select({ key: product.key })
      .from(product)
      .orderBy(asc(product.key))
      .all()
      .map((p) => p.key);
    throw new ValidationError(
      `no product ${unknown.join(", ")}: ${
        existing.length === 0
          ? "there is no product yet, so leave products out"
          : `scope the key to products that exist, which are ${existing.join(", ")}`
      }`,
    );
  }
  return found.map((p) => p.id);
}

/** The ids of the projects with these slugs; null for a list left out. */
function projectIdsOf(tx: Tx, slugs: string[] | undefined): string[] | null {
  if (slugs === undefined) return null;
  if (slugs.length === 0) {
    throw new ValidationError(
      "projects must name at least one project: leave it out for a key that isn't limited to projects",
    );
  }
  const wanted = [...new Set(slugs.map((s) => s.trim()))];
  const found = tx
    .select({ id: project.id, slug: project.slug })
    .from(project)
    .where(inArray(project.slug, wanted))
    .all();
  const unknown = wanted.filter((s) => !found.some((p) => p.slug === s));
  if (unknown.length > 0) {
    const existing = tx
      .select({ slug: project.slug })
      .from(project)
      .orderBy(asc(project.slug))
      .all()
      .map((p) => p.slug);
    throw new ValidationError(
      `no project ${unknown.join(", ")}: ${
        existing.length === 0
          ? "there is no project yet, so leave projects out"
          : `scope the key to projects that exist, by slug, which are ${existing.join(", ")}`
      }`,
    );
  }
  return found.map((p) => p.id);
}

function mintKey(tx: Tx, actorId: string, scope: KeyScopeInput): string {
  const actions = validActions(scope.actions);
  const productIds = productIdsOf(tx, scope.products);
  const projectIds = projectIdsOf(tx, scope.projects);
  const prefix = randomBytes(4).toString("hex");
  const key = `trail_${prefix}_${randomBytes(32).toString("base64url")}`;
  const { id } = tx
    .insert(apiKey)
    .values({ actorId, prefix, hash: sha256(key).toString("hex"), actions })
    .returning({ id: apiKey.id })
    .get();
  if (productIds !== null) {
    tx.insert(apiKeyProduct)
      .values(productIds.map((productId) => ({ apiKeyId: id, productId })))
      .run();
  }
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
 * The bot whose actor id, label or name (ignoring the case of A-Z) is `ref`; an
 * id wins outright, and a label or name matching two bots is ambiguous. An id
 * that is a person's is refused, `why` saying what that person can't have.
 */
export function botByRef(tx: Tx, ref: string, why: string): Actor {
  const bot =
    tx.select().from(actor).where(eq(actor.id, ref)).get() ??
    onlyBotByLabelOrName(tx, ref);
  if (!bot) {
    throw new NotFoundError(
      `no bot with id, label or name ${ref}: \`trail key list\` shows each bot's id, name and label`,
    );
  }
  if (bot.kind !== "bot") {
    throw new ConflictError(`${bot.id} is a person, not a bot: ${why}`);
  }
  return bot;
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
      const bot = botByRef(
        tx,
        botRef,
        "people's names come from their sign-in",
      );
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

/**
 * Sets a bot's title, trimmed, or clears it with null; `botRef` finds the bot
 * as `renameBot`'s does. People are refused: only bots have titles.
 */
export function setBotTitle(
  db: Db,
  botRef: string,
  newTitle: string | null,
): { id: string; oldTitle: string | null; newTitle: string | null } {
  const title = newTitle === null ? null : validBotTitle(newTitle);
  return db.transaction(
    (tx) => {
      const bot = botByRef(tx, botRef, "only bots have titles");
      tx.update(actor).set({ title }).where(eq(actor.id, bot.id)).run();
      return { id: bot.id, oldTitle: bot.title, newTitle: title };
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

/** The products and projects of these keys' scopes, by key id; an unrestricted key has products null. */
function scopesOf(
  tx: Tx | Db,
  keyIds: string[],
): Map<string, Pick<KeyScope, "products" | "projects">> {
  const products =
    keyIds.length === 0
      ? []
      : tx
          .select({
            keyId: apiKeyProduct.apiKeyId,
            id: product.id,
            key: product.key,
          })
          .from(apiKeyProduct)
          .innerJoin(product, eq(product.id, apiKeyProduct.productId))
          .where(inArray(apiKeyProduct.apiKeyId, keyIds))
          .orderBy(asc(product.key))
          .all();
  const projects =
    keyIds.length === 0
      ? []
      : tx
          .select({
            keyId: apiKeyProject.apiKeyId,
            id: project.id,
            slug: project.slug,
          })
          .from(apiKeyProject)
          .innerJoin(project, eq(project.id, apiKeyProject.projectId))
          .where(inArray(apiKeyProject.apiKeyId, keyIds))
          .orderBy(asc(project.slug))
          .all();
  const scopes = new Map<string, Pick<KeyScope, "products" | "projects">>();
  for (const keyId of keyIds) {
    const own = products.filter((p) => p.keyId === keyId);
    const groups = projects.filter((p) => p.keyId === keyId);
    scopes.set(keyId, {
      products:
        own.length === 0 && groups.length === 0
          ? null
          : own.map(({ id, key }) => ({ id, key })),
      projects: groups.map(({ id, slug }) => ({ id, slug })),
    });
  }
  return scopes;
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
  const scopes = scopesOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map(({ id, actions, ...listing }) => ({
    ...listing,
    scope: scopeView({
      ...(scopes.get(id) as Pick<KeyScope, "products" | "projects">),
      actions,
    }),
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

/** Product keys and project slugs to add to a key's scope and to take off it. */
export type KeyScopeEdit = {
  addProducts?: string[];
  removeProducts?: string[];
  addProjects?: string[];
  removeProjects?: string[];
};

/**
 * Adds and removes products and projects on the live key with this prefix, in
 * one transaction, and returns its scope. Adding what the key has, or removing
 * what it hasn't, changes nothing. Refused: adding to an unrestricted key, and
 * an edit leaving a restricted key with neither, which would make it unrestricted.
 */
export function editKeyScope(
  db: Db,
  prefix: string,
  edit: KeyScopeEdit,
): KeyScopeView {
  return db.transaction(
    (tx) => {
      const key = tx
        .select({ id: apiKey.id, actions: apiKey.actions })
        .from(apiKey)
        .where(and(eq(apiKey.prefix, prefix), isNull(apiKey.revokedAt)))
        .get();
      if (!key) {
        throw new NotFoundError(
          `no live key with prefix ${prefix}: \`trail key list\` shows each key's prefix`,
        );
      }
      const current = scopesOf(tx, [key.id]).get(key.id) as Pick<
        KeyScope,
        "products" | "projects"
      >;
      const adds =
        (edit.addProducts?.length ?? 0) + (edit.addProjects?.length ?? 0) > 0;
      if (current.products === null && adds) {
        throw new ValidationError(
          "this key is unrestricted and already reaches every product and project, so adding to it changes nothing: mint a key limited to what it should reach with `trail key create`, and revoke this one",
        );
      }
      const addProducts = edit.addProducts?.length
        ? (productIdsOf(tx, edit.addProducts) as string[])
        : [];
      const addProjects = edit.addProjects?.length
        ? (projectIdsOf(tx, edit.addProjects) as string[])
        : [];
      const productKeys = (edit.removeProducts ?? []).map((k) =>
        k.trim().toUpperCase(),
      );
      const slugs = (edit.removeProjects ?? []).map((s) => s.trim());
      const products = new Set(
        (current.products ?? [])
          .filter((p) => !productKeys.includes(p.key))
          .map((p) => p.id),
      );
      const projects = new Set(
        current.projects
          .filter((p) => !slugs.includes(p.slug))
          .map((p) => p.id),
      );
      for (const id of addProducts) products.add(id);
      for (const id of addProjects) projects.add(id);
      if (current.products === null) {
        return scopeView({ ...current, actions: key.actions });
      }
      if (products.size === 0 && projects.size === 0) {
        throw new ValidationError(
          `that edit leaves the key with no product and no project, and a key with neither reaches everything: add a product or project in the same edit, or revoke the key with \`trail key revoke ${prefix}\``,
        );
      }
      tx.delete(apiKeyProduct).where(eq(apiKeyProduct.apiKeyId, key.id)).run();
      tx.delete(apiKeyProject).where(eq(apiKeyProject.apiKeyId, key.id)).run();
      if (products.size > 0) {
        tx.insert(apiKeyProduct)
          .values(
            [...products].map((productId) => ({ apiKeyId: key.id, productId })),
          )
          .run();
      }
      if (projects.size > 0) {
        tx.insert(apiKeyProject)
          .values(
            [...projects].map((projectId) => ({ apiKeyId: key.id, projectId })),
          )
          .run();
      }
      return scopeView({
        ...(scopesOf(tx, [key.id]).get(key.id) as Pick<
          KeyScope,
          "products" | "projects"
        >),
        actions: key.actions,
      });
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
      ...(scopesOf(db, [row.id]).get(row.id) as Pick<
        KeyScope,
        "products" | "projects"
      >),
      actions: row.actions,
    },
  };
}
