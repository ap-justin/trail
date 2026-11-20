import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import { newId } from "../db/id.js";
import type { ActorKind, ApiKeyAction, ProductKind } from "../db/schema.js";
import {
  activityEvent,
  actorPhoto,
  actor as actorTable,
  apiKey,
  apiKeyProduct,
  comment,
  type IssueStatus,
  type IssueType,
  issue,
  issueLabel,
  issueLink,
  label,
  noteAbout,
  noteStatuses,
  type ProjectHealth,
  product,
  productStatusUpdate,
  project,
  projectItem,
  projectProduct,
  projectStatusUpdate,
  type WebhookSubscriptionKind,
  webhookSubscription,
} from "../db/schema.js";
import type { ActivityEvent, EventBus } from "../events/bus.js";
import type {
  PullRequestState,
  PullRequests,
} from "../github/pull-requests.js";
import { checkWebhookUrl, UnsafeUrlError } from "../webhooks/address.js";
import { openSecret, sealSecret } from "../webhooks/secret.js";
import { sendWebhook } from "../webhooks/send.js";
import {
  ConflictError,
  ForbiddenActionError,
  ForbiddenError,
  ForbiddenScopeError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "./errors.js";
import {
  type IdempotentRequest,
  replayOf,
  storeResult,
  validIdempotencyKey,
} from "./idempotency.js";
import {
  type ImportCounts,
  type ImportPayload,
  type importedEventPayload,
  type NormalComment,
  type NormalImport,
  type NormalIssue,
  normalImport,
  zeroCounts,
} from "./import.js";
import { type Actor, andList, type KeyScope } from "./keys.js";
import { createMessaging } from "./messages.js";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  type FeedFilters,
  type Page,
  type PageQuery,
  page,
  pageLimit,
} from "./paging.js";
import { clearActorPhoto, photoUrl, setActorPhoto } from "./photos.js";
import type { Tx } from "./tx.js";
import {
  completedAtOf,
  ITEM_NOTES_MAX,
  type Link,
  type LinkInput,
  labelKey,
  NOTE_ABOUT_MAX,
  nonBlank,
  optionalRef,
  SLUG_MAX,
  slugOfName,
  validBotTitle,
  validEstimate,
  validHealth,
  validLabelNames,
  validLinks,
  validPriority,
  validProductKey,
  validRepoUrl,
  validSlug,
  validStatus,
  validTargetDate,
  withinIssueCap,
} from "./validate.js";
import {
  amongProducts,
  eventForReach,
  eventsReached,
  itemsReached,
  noIssue,
  noProduct,
  noProject,
  noteOnIssueRoute,
  productsNamed,
  projectsReached,
  type Reach,
  reachOfScope,
} from "./visible.js";
import {
  countOwn,
  createPingLimiter,
  enqueueDeliveries,
  insertSubscription,
  PING_LIMIT,
  PING_WINDOW_MS,
  resume,
  setFollows,
  validSecret,
  WEBHOOK_PRODUCTS_MAX,
  WEBHOOKS_PER_BOT_MAX,
  type Webhook,
  type WebhookSettings,
  webhooksOf,
} from "./webhooks.js";

export type {
  ImportComment,
  ImportCounts,
  ImportIssue,
  ImportPayload,
  ImportStatusUpdate,
} from "./import.js";
export { importedEventPayload } from "./import.js";
export type { Actor } from "./keys.js";
export type {
  BotRef,
  Conversation,
  MarkReadResult,
  Message,
  SentMessage,
} from "./messages.js";
export type { Page, PageQuery } from "./paging.js";
export type { Link, LinkInput } from "./validate.js";

/**
 * Who a call acts as. A bot key's `scope` limits what it reaches; a person
 * carries none, and /api/web applies their visibility before calling.
 */
export type ActingActor = Pick<Actor, "id" | "kind"> & {
  /** the key the call came with; none for a person */
  keyId?: string;
  scope?: KeyScope;
};
/** An actor with the URL of its photo, null without one. */
export type ActorWithPhoto = Actor & { photoUrl: string | null };
export type Product = typeof product.$inferSelect;
export type ProjectRow = typeof project.$inferSelect;
type IssueRow = typeof issue.$inferSelect;
/** A bot or person as a row names it. */
export type ActorRef = { id: string; name: string; kind: ActorKind };
/**
 * An item with its key (as in TRL-12), its product's key, label names A to Z,
 * links in the order set, its assignee, and the projects it belongs to (all
 * visible to whoever sees the item: each draws from the item's product).
 */
export type Issue = IssueRow & {
  key: string;
  productKey: string;
  labels: string[];
  /** pr: a pull request link's cached state, see `withPullRequests` */
  links: (Link & { pr?: PullRequestState })[];
  assignee: ActorRef | null;
  projects: { slug: string; name: string }[];
  /** On a bot's get_item: why its key reaches the item; see `ItemAccess`. */
  access?: ItemAccess;
  /** On a note: the items it is about that the caller reaches, in key order. */
  about?: ItemRef[];
  /** On get_item: the newest current notes about the item that the caller reaches, newest first. */
  notes?: ItemRef[];
  /** On get_item: every note about the item that the caller reaches, per status. */
  notesCount?: NoteCounts;
};

/** An item as another item names it. */
export type ItemRef = {
  key: string;
  title: string;
  type: IssueType;
  status: IssueStatus;
};

/**
 * Why a bot key reaches an item, the strongest grant first: its product
 * grant covers the item's product (an unrestricted key's too), a project it
 * lists holds the item, or a project drawing from one of its products holds
 * it, which lets the key read the item and comment on it and nothing else.
 */
export type ItemAccess = "product" | "project" | "via_project";

/** An item the product's own bot creates is a todo; anyone else's is an issue. */
const legacyTypeOf = (target: Product, creatorId: string): IssueType =>
  target.ownerId === creatorId ? "todo" : "issue";

const aType = (type: IssueType) =>
  type === "issue" ? "an issue" : `a ${type}`;

/** The types of the items someone works on: everything but notes. */
const workTypes = ["issue", "todo"] as const satisfies readonly IssueType[];

/** The status each type of item is created in. */
const startStatus = {
  issue: "triage",
  todo: "open",
  note: "current",
} as const satisfies Record<IssueType, IssueStatus>;

export type Comment = typeof comment.$inferSelect;
export type Label = typeof label.$inferSelect;
/** A status update on a product or on a project: exactly one of the two is set. */
export type StatusUpdate = {
  id: string;
  productId: string | null;
  productKey: string | null;
  projectId: string | null;
  projectSlug: string | null;
  authorId: string;
  body: string;
  health: ProjectHealth;
  externalRef: string | null;
  sourceAuthor: string | null;
  createdAt: Date;
};

/** A product with its owner bot. */
export type ProductView = Product & { owner: ActorRef | null };

/** A product the actor reaches only through a project: what it may name, and no more. */
export type NamedProduct = Pick<Product, "id" | "key" | "name">;

export type NoteStatus = (typeof noteStatuses)[number];
/** A status an issue or a todo takes. */
export type WorkStatus = Exclude<IssueStatus, NoteStatus>;
/** Issues and todos per status; notes are counted apart, in `NoteCounts`. */
export type ItemCounts = Record<WorkStatus, number>;
export type NoteCounts = Record<NoteStatus, number>;

export const isNoteStatus = (status: IssueStatus): status is NoteStatus =>
  (noteStatuses as readonly IssueStatus[]).includes(status);

/** Whether a write sends no priority or estimate but a note's own, priority 0 and estimate null, as get_item shows them. */
const holdsANotesRank = (sent: {
  priority?: number;
  estimate?: number | null;
}): boolean =>
  (sent.priority === undefined || sent.priority === 0) &&
  (sent.estimate === undefined || sent.estimate === null);

/**
 * A project as one caller sees it: only the products it reaches, `hiddenProducts`
 * when the project draws from others, and counts over the items of reachable
 * products alone.
 */
export type ProjectView = ProjectRow & {
  lead: ActorRef;
  products: { id: string; key: string; name: string }[];
  hiddenProducts: boolean;
  counts: ItemCounts;
  notes: NoteCounts;
  latestStatusUpdate: (StatusUpdate & { author: ActorRef }) | null;
};

/** A product as get_product reads it: with its notes per status. */
export type ProductDetail = ProductView & { notes: NoteCounts };

/**
 * What `get_project` and `update_project` found: a project, or a product by
 * the legacy meaning, named only (`P` widened to `NamedProduct`) where a read
 * reaches it only through a project.
 */
export type ProjectOrProduct<
  P extends ProductView | NamedProduct = ProductView,
> = { kind: "project"; project: ProjectView } | { kind: "product"; product: P };

/** Every create takes these; a repeat with the same key returns the first result. */
export type WriteOptions = { idempotencyKey?: string };

export type ProductInput = {
  name: string;
  key: string;
  description?: string;
  externalRef?: string | null;
  repoUrl?: string | null;
  /** a bot's id or name; the caller by default */
  owner?: string | null;
  kind?: ProductKind;
};
/** A team as its own bot creates it with create_team. */
export type TeamInput = Pick<ProductInput, "name" | "key" | "description">;
export type ProductPatch = {
  name?: string;
  description?: string;
  repoUrl?: string | null;
  /** a bot's id or name; null leaves the product without an owner */
  owner?: string | null;
  kind?: ProductKind;
};
/** An item to create. `product` takes the product's key or id. */
export type ItemInput = {
  product?: string;
  /** an issue's project, by slug: the issue joins it as it is filed */
  project?: string;
  title: string;
  description?: string;
  /** a bot's id or name, or a person's id */
  assignee?: string | null;
  estimate?: number | null;
  priority?: number;
  labels?: string[];
  links?: LinkInput[];
  externalRef?: string | null;
  /** a note's: keys of the items it is about */
  about?: string[];
};
/** How the legacy create and list name a product: `projectId`, or `project` or `product`, its aliases. */
export type LegacyProductRef = {
  projectId?: string;
  project?: string;
  product?: string;
};

/** The product's id or key a legacy call named, under whichever spellings it used; two spellings with different values are refused. */
export function legacyProduct(ref: LegacyProductRef): string | undefined {
  const sent = new Set(
    [ref.projectId, ref.project, ref.product].filter(
      (value) => value !== undefined,
    ),
  );
  if (sent.size > 1) {
    throw new ValidationError(
      "send one of projectId, project or product: they name the same product, and two different values are ambiguous",
    );
  }
  return [...sent][0];
}

/** The legacy create: `projectId` (or an alias) takes the product's id or key. */
export type IssueInput = LegacyProductRef & {
  title: string;
  description?: string;
  assigneeId?: string | null;
  estimate?: number | null;
  priority?: number;
  labels?: string[];
  links?: LinkInput[];
  externalRef?: string | null;
};
export type IssuePatch = {
  type?: IssueType;
  title?: string;
  description?: string;
  status?: IssueStatus;
  /** a bot's id or name, or a person's id; null unassigns an issue */
  assigneeId?: string | null;
  /** null clears */
  estimate?: number | null;
  priority?: number;
  /** replaces the item's labels */
  labels?: string[];
  /** replaces the item's links */
  links?: LinkInput[];
  /** added to the item's labels; refused beside `labels` */
  addLabels?: string[];
  /** removed from the item's labels, matched ignoring the case of A-Z; refused beside `labels` */
  removeLabels?: string[];
  /** added to the item's links, a url already there taking the new title; refused beside `links` */
  addLinks?: LinkInput[];
  /** urls of links to remove; refused beside `links` */
  removeLinks?: string[];
  /** a note's: replaces the items it is about, by key */
  about?: string[];
  /** added to the items a note is about; refused beside `about` */
  addAbout?: string[];
  /** removed from the items a note is about; refused beside `about` */
  removeAbout?: string[];
};
export type CommentInput = {
  issueId: string;
  body: string;
  externalRef?: string | null;
};
/** Exactly one of `product` (key or id) and `project` (slug). */
export type StatusTarget = { product?: string; project?: string };
export type StatusUpdateInput = StatusTarget & {
  body: string;
  health: ProjectHealth;
  externalRef?: string | null;
};
export type LabelInput = { productId: string; name: string };
export type ProjectInput = {
  name: string;
  slug?: string;
  goal?: string;
  /** a bot's id or name; the caller by default */
  lead?: string;
  targetDate?: string | null;
  /** product keys; the caller's own product when it has exactly one */
  products?: string[];
};
export type ProjectPatch = {
  name?: string;
  goal?: string;
  lead?: string;
  /** null clears */
  targetDate?: string | null;
};
/** An imported issue that could not keep its source key's number and took the product's next one. */
export type Renumbered = {
  externalRef: string;
  sourceKey: string | null;
  key: string;
};
export type ImportResult = {
  product: ProductView;
  renumbered: Renumbered[];
  created: ImportCounts;
  updated: ImportCounts;
  unchanged: ImportCounts;
};
export type ItemQuery = PageQuery & {
  /** a product's key or id */
  product?: string;
  /** a project's slug */
  project?: string;
  type?: IssueType;
  /** one status, or any of several */
  status?: IssueStatus | readonly IssueStatus[];
  /** a bot's id or name, or a person's id */
  assignee?: string;
  /** an item's key: the notes about it */
  about?: string;
};
/**
 * `cursor` pages newest first; `after` resumes oldest first from a cursor ("" is
 * the start of the feed), and its page always carries a cursor to resume from.
 */
export type ActivityQuery = PageQuery & {
  after?: string;
  /** a product's key or id */
  product?: string;
  /** a project's slug */
  project?: string;
  actorId?: string;
};

/** An activity event with the key of its product and the slug of its project, each null when it has none. */
export type ActivityEntry = ActivityEvent & {
  productKey: string | null;
  projectSlug: string | null;
};

/** What whoami reports beside the actor: its own products and every product the key reaches, A to Z by key. */
export type Whoami = ActorWithPhoto & {
  ownProducts: Product[];
  products: Product[];
  /** The slugs of the projects its key reads through its products, A to Z; see `implicitProjectsOf`. */
  impliedProjects: string[];
  unreadMessages: number;
  /** its own team, whatever its key reaches */
  team: Product | null;
  /** present only when it owns no product and no team */
  hint?: string;
};

/** whoami's hint for a bot that owns nothing: create_team only where the calling key may use it. */
function ownsNothingHint(scope: KeyScope | undefined): string {
  const projectsOnly = scope?.products?.length === 0;
  if (scope?.actions != null && !scope.actions.includes("issues")) {
    return `You own no product and no team, and this key lacks the issues action, so it can't create your team, add notes or file issues: ask whoever minted it for a key with the issues action${projectsOnly ? " and a product list" : ""}.`;
  }
  if (projectsOnly) {
    return "You own no product and no team, and this key reaches only projects, so it can't create your team: ask whoever minted it for a key with a product list. Write records with add_note; to ask a product's bot for work, file an issue on its product with file_issue.";
  }
  return "You own no product and no team. For your own work, create your team with create_team and add todos there; write records with add_note; to ask a product's bot for work, file an issue on its product with file_issue.";
}

/** What an activity webhook follows: product keys and project slugs. */
export type Follows = { products?: string[]; projects?: string[] };

/** A created or updated webhook; `productAlias` when `projects` carried product keys, its deprecated use. */
export type WebhookWritten = Webhook & { productAlias: boolean };

const followsSent = (input: Follows) =>
  input.products !== undefined || input.projects !== undefined;

/** Most items one add_to_project call takes. */
export const PROJECT_ITEMS_MAX = 100;
/** Most products one project create names. */
export const PROJECT_PRODUCTS_MAX = 50;

type NewEvent = Omit<typeof activityEvent.$inferInsert, "id" | "createdAt">;
type Change = { from: unknown; to: unknown };
/** A write and the events it records, in order; none when nothing changed. */
type Write<T> = { result: T; event: NewEvent | NewEvent[] | null };

// a product key, a dash and the issue's number: TRL-12
const issueKeyPattern = /^([A-Za-z0-9]{2,10})-(\d+)$/;

/** Only a bot may make this write; checked before the database is touched. */
function requireBot(actor: ActingActor, write: string): void {
  if (actor.kind !== "bot") {
    throw new ForbiddenError(`only a bot may ${write}`);
  }
}

/**
 * Refuses a call the actor's key lacks `action` for, naming the call as
 * `doing`. `reach` looks up the call's target first, so one the key can't see
 * is the 404 a missing one is, whatever the key's actions.
 */
function requireAction(
  actor: ActingActor,
  action: ApiKeyAction,
  doing: string,
  reach?: () => unknown,
): void {
  const actions = actor.scope?.actions;
  if (actions == null || actions.includes(action)) return;
  reach?.();
  throw new ForbiddenActionError(
    `this key may not ${doing}: that needs the ${action} action, and the key has ${andList(actions)}. Ask whoever minted the key for one with the ${action} action.`,
  );
}

const plural = (n: number) => (n > 1 ? "s" : "");

/** "product A", "products A and B", "project recon", "product A and project recon": what a restricted key reaches. */
const reachOf = ({ products, projects }: KeyScope) =>
  andList(
    [
      products?.length
        ? `product${plural(products.length)} ${andList(products.map((p) => p.key))}`
        : "",
      projects.length
        ? `project${plural(projects.length)} ${andList(projects.map((p) => p.slug))}`
        : "",
    ].filter((part) => part !== ""),
  );

/** The key the minter is asked for instead of a restricted one. */
const unlimitedKey = (scope: KeyScope) =>
  scope.projects.length === 0
    ? "one with no product list"
    : "one with no product or project list";

/** Fields of `patch` whose value differs from `current`, as from/to pairs. */
function changesOf<T extends object>(
  current: T,
  patch: Partial<T>,
): Record<string, Change> {
  const changes: Record<string, Change> = {};
  for (const [field, to] of Object.entries(patch)) {
    if (to === undefined) continue;
    const from = current[field as keyof T];
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

/** The fields of `next` whose value differs from `current`, Dates compared by instant. */
function changedFields<T extends object>(
  current: T,
  next: Partial<T>,
): Partial<T> {
  const changed: Partial<T> = {};
  for (const field of Object.keys(next) as (keyof T)[]) {
    const to = next[field];
    if (to === undefined) continue;
    const from = current[field];
    const same =
      from instanceof Date && to instanceof Date
        ? from.getTime() === to.getTime()
        : from === to;
    if (!same) changed[field] = to;
  }
  return changed;
}

const isEmpty = (fields: object) => Object.keys(fields).length === 0;

/** What the actor reaches: everything, unless its scope limits it to products, projects or both. */
const reachFor = (actor: ActingActor): Reach =>
  actor.scope ? reachOfScope(actor.scope, actor.kind === "bot") : null;

/** The product ids the actor's own product grant covers, null for every one; a project grant adds none. */
const productIdsOf = (actor: ActingActor): readonly string[] | null =>
  reachFor(actor)?.products ?? null;

/** The project ids the actor's own project grant lists, null for every one; a product grant adds none. */
const projectIdsOf = (actor: ActingActor): readonly string[] | null =>
  reachFor(actor)?.projects ?? null;

/** The actor's product grant covers the product: every one of its items is reached. */
const grantsProduct = (actor: ActingActor, productId: string) =>
  productIdsOf(actor)?.includes(productId) ?? true;

/** "project recon", "projects recon and solo" */
const projectList = (slugs: readonly string[]) =>
  `project${plural(slugs.length)} ${andList(slugs)}`;

/** "product ATL or project recon", "product ATL or one of projects recon, solo": the grants that would widen a key's implicit read. */
const grantsFor = (productKey: string, slugs: readonly string[]) =>
  `product ${productKey} or ${slugs.length === 1 ? `project ${slugs[0]}` : `one of projects ${slugs.join(", ")}`}`;

/** `project: "recon"`, `project: "recon" or project: "solo"`: the argument to resend with. */
const projectArgs = (slugs: readonly string[]) =>
  slugs.map((s) => `project: "${s}"`).join(" or ");

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

type ActorWithHash = Actor & { photoHash: string | null };

const withPhotoUrl = ({
  photoHash,
  ...row
}: ActorWithHash): ActorWithPhoto => ({
  ...row,
  photoUrl: photoUrl(row.id, photoHash),
});

export type { Webhook, WebhookSettings } from "./webhooks.js";
/** What a test call to a webhook found. */
export type WebhookTestResult = {
  delivered: boolean;
  status: number | null;
  error: string | null;
};

export function createService({
  db,
  bus,
  webhooks,
  pullRequests,
}: {
  db: Db;
  bus: EventBus;
  webhooks: WebhookSettings;
  pullRequests: PullRequests;
}) {
  const pings = createPingLimiter(() => webhooks.now());
  const messaging = createMessaging({ db, bus, now: () => webhooks.now() });

  /** Actors with their photo's hash; the bytes stay in actor_photo. */
  const selectWithPhotoHash = () =>
    db
      .select({ ...getTableColumns(actorTable), photoHash: actorPhoto.hash })
      .from(actorTable)
      .leftJoin(actorPhoto, eq(actorPhoto.actorId, actorTable.id));

  /** Tells live actor subscribers the actor's photo and title as they are now. */
  function publishActor(actorId: string) {
    const now = withPhotoUrl(
      selectWithPhotoHash()
        .where(eq(actorTable.id, actorId))
        .get() as ActorWithHash,
    );
    bus.publishActor({ actorId, photoUrl: now.photoUrl, title: now.title });
  }

  function setTitle(actorId: string, title: string | null) {
    const changed = db
      .update(actorTable)
      .set({ title })
      .where(
        and(
          eq(actorTable.id, actorId),
          sql`${actorTable.title} is not ${title}`,
        ),
      )
      .run().changes;
    if (changed > 0) publishActor(actorId);
  }

  /**
   * Product keys or ids as the product ids a webhook follows. One the key
   * can't see is a 404, as everywhere, one it reaches only through its
   * projects a 404 saying to follow those, for the events of their items, and
   * a project's slug a 422 saying to send it in `projects`.
   */
  function webhookProductIds(actor: ActingActor, refs: string[]): string[] {
    if (refs.length > WEBHOOK_PRODUCTS_MAX) {
      throw new ValidationError(
        `products names ${refs.length} products, over the limit of ${WEBHOOK_PRODUCTS_MAX}: follow fewer, or split them across webhooks`,
      );
    }
    const idOf = (ref: string) => {
      try {
        return findProduct(
          db,
          ref,
          amongProducts(product.id, productIdsOf(actor)),
        ).id;
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        const named = namedOnly(db, ref, actor);
        if (named) {
          const slugs = [
            ...projectsDrawingFrom(db, actor, named.id),
            ...implicitProjectsOf(db, actor, named.id),
          ]
            .map((p) => p.slug)
            .sort();
          throw new NotFoundError(
            `this key reaches product ${named.key} only through ${projectList(slugs)}: send projects: ${JSON.stringify(slugs)} in place of ${named.key}, for the events of the project's items; the rest of ${named.key} needs a key that lists ${named.key}`,
          );
        }
        const slugged = findProject(db, ref, actor);
        if (!slugged) throw error;
        throw new ValidationError(
          `products takes product keys and ${ref} is a project's slug: send it in projects (projects: ["${slugged.slug}"])`,
        );
      }
    };
    return [...new Set(refs.map(idOf))];
  }

  /**
   * `projects` as sent, value by value: a project's slug follows the project,
   * and a product's key in any case (upper-cased, which no slug matches) is
   * the deprecated alias of `products`. One the key can name
   * neither way is the 404 a missing project is.
   */
  function splitProjectRefs(
    actor: ActingActor,
    refs: string[],
  ): { projectIds: string[]; productKeys: string[] } {
    if (refs.length > WEBHOOK_PRODUCTS_MAX) {
      throw new ValidationError(
        `projects names ${refs.length} projects, over the limit of ${WEBHOOK_PRODUCTS_MAX}: follow fewer, or split them across webhooks`,
      );
    }
    const projectIds: string[] = [];
    const productKeys: string[] = [];
    for (const ref of refs) {
      const found = db
        .select({ id: project.id })
        .from(project)
        .where(and(eq(project.slug, ref.trim()), reachableProjects(actor)))
        .get();
      if (found) {
        projectIds.push(found.id);
        continue;
      }
      const named = db
        .select({ key: product.key })
        .from(product)
        .where(
          and(
            eq(product.key, ref.trim().toUpperCase()),
            productsNamed(db, reachFor(actor), product.id),
          ),
        )
        .get();
      if (!named) throw noProject(ref);
      productKeys.push(named.key);
    }
    return { projectIds: [...new Set(projectIds)], productKeys };
  }

  /**
   * The products and projects an activity webhook follows, as ids, from the
   * lists sent; a list left out is undefined. Product keys sent in `projects`
   * join `products`, and `productAlias` says some were; a `projects` of
   * product keys alone leaves the project follows as they are. A key reaching exactly
   * one project and no product follows that project when neither list is sent.
   */
  function webhookFollows(
    actor: ActingActor,
    input: Follows,
  ): { productIds?: string[]; projectIds?: string[]; productAlias: boolean } {
    const scope = actor.scope;
    const soleProject =
      scope?.products?.length === 0 && scope.projects.length === 1
        ? scope.projects[0]
        : undefined;
    if (!followsSent(input) && soleProject) {
      return {
        productIds: [],
        projectIds: [soleProject.id],
        productAlias: false,
      };
    }
    const split =
      input.projects === undefined
        ? undefined
        : splitProjectRefs(actor, input.projects);
    const productAlias = (split?.productKeys.length ?? 0) > 0;
    const productRefs =
      input.products === undefined && !productAlias
        ? undefined
        : [...(input.products ?? []), ...(split?.productKeys ?? [])];
    return {
      ...(productRefs !== undefined && {
        productIds: webhookProductIds(actor, productRefs),
      }),
      // a list of product keys alone is the old alias call, which leaves project follows alone
      ...(split !== undefined &&
        (split.projectIds.length > 0 || !productAlias) && {
          projectIds: split.projectIds,
        }),
      productAlias,
    };
  }

  /** The URL vetted and its address resolved; a refusal is a 422 saying why. */
  async function checkedUrl(raw: string) {
    try {
      return await checkWebhookUrl(raw, webhooks.resolve);
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        throw new ValidationError(error.message);
      }
      throw error;
    }
  }

  /** True when every product the webhook follows is within the key's products, and every project it follows is one whose items the key reads. */
  function withinScope(actor: ActingActor, hook: Webhook): boolean {
    const scoped = actor.scope?.products;
    if (scoped == null) return true;
    if (!hook.products.every((key) => scoped.some((p) => p.key === key))) {
      return false;
    }
    if (hook.projects.length === 0) return true;
    const reached = db
      .select({ n: sql<number>`count(*)` })
      .from(project)
      .where(
        and(inArray(project.slug, hook.projects), reachableProjects(actor)),
      )
      .get()?.n;
    return reached === hook.projects.length;
  }

  /** True when the key can read, update and delete the webhook: an activity one needs the read action too. */
  function canManage(actor: ActingActor, hook: Webhook): boolean {
    const reads = actor.scope?.actions?.includes("read") ?? true;
    return withinScope(actor, hook) && (reads || hook.kind === "inbox");
  }

  /**
   * The `apiKeyId` a write records on a webhook: the key making it, which
   * deliveries are checked against from then on (an inbox webhook's only for
   * being live). It passed `canManage`, so it reaches what the webhook follows.
   */
  function managingKey(actor: ActingActor) {
    return actor.keyId ? { apiKeyId: actor.keyId } : {};
  }

  /** The 409 for a URL the bot already uses: names the webhook only when this key can manage it. */
  function twinConflict(
    actor: ActingActor,
    twinId: string,
    from: Db | Tx,
    advice: string,
  ) {
    const unmanaged = new ConflictError(
      "this bot already has a webhook to that URL that this key can't manage: use a different URL, or ask for a key that can read every product and project that webhook follows",
    );
    try {
      if (!canManage(actor, ownWebhook(actor, twinId, from).view)) {
        return unmanaged;
      }
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      return unmanaged;
    }
    return new ConflictError(
      `webhook ${twinId} already sends to this URL: ${advice}`,
    );
  }

  /**
   * `requireAction` for a call on webhook `id`: the read action, except on an
   * inbox webhook, which is messaging and open to every key. One the caller
   * can't see is a 404 first. Returns `ownWebhook`'s result.
   */
  function requireWebhookAction(actor: ActingActor, id: string, doing: string) {
    const own = ownWebhook(actor, id);
    if (!canManage(actor, own.view)) requireAction(actor, "read", doing);
    return own;
  }

  /** The calling bot's webhook, or a 404: another bot's and one the key's scope doesn't cover read as missing. */
  function ownWebhook(actor: ActingActor, id: string, from: Db | Tx = db) {
    const row = from
      .select()
      .from(webhookSubscription)
      .where(
        and(
          eq(webhookSubscription.id, id),
          eq(webhookSubscription.actorId, actor.id),
        ),
      )
      .get();
    const view = row && (webhooksOf(from, [row])[0] as Webhook);
    if (!row || !view || !withinScope(actor, view)) {
      throw new NotFoundError(
        `no webhook ${id}: list yours with list_webhooks (GET /webhooks)`,
      );
    }
    return { view, cipher: row.secretCipher };
  }

  /**
   * Runs `write` and the activity event it returns in one immediate
   * transaction, then publishes the committed event. `write` returns a null
   * event when there is nothing to record, and the transaction writes nothing.
   */
  function commit<T>(write: (tx: Tx) => Write<T>): T {
    const { result, events } = db.transaction(
      (tx) => {
        const { result, event } = write(tx);
        const events = event === null ? [] : [event].flat();
        // one insert per event: each reads max(seq) for its own
        const committed = events.map((e) => {
          const row = tx.insert(activityEvent).values(e).returning().get();
          enqueueDeliveries(tx, row, webhooks.now());
          return row;
        });
        return { result, events: committed };
      },
      { behavior: "immediate" },
    );
    for (const event of events) bus.publish(event);
    return result;
  }

  /**
   * `commit` for a create. `prepare` resolves the input inside the transaction
   * and returns it normalised as `request`, which an idempotency key is checked
   * against before `write` runs; a replay writes nothing and returns the first
   * result once `replay` passes it: the access checks `write` runs, then the
   * 404 a read gives when the caller no longer reaches what the result is on.
   * `replay` is left out where `prepare` already resolved that among what the
   * caller reaches.
   */
  function create<T>(
    actor: ActingActor,
    options: WriteOptions,
    scope: string,
    prepare: (tx: Tx) => {
      request: unknown;
      legacyRequest?: unknown;
      write: () => Write<T>;
      replay?: (stored: T) => void;
    },
  ): T {
    const key =
      options.idempotencyKey === undefined
        ? undefined
        : validIdempotencyKey(options.idempotencyKey);
    return commit((tx) => {
      const { request, legacyRequest, write, replay: check } = prepare(tx);
      if (key === undefined) return write();
      const idem: IdempotentRequest = { key, scope, request, legacyRequest };
      const replay = replayOf<T>(tx, actor.id, idem);
      if (replay !== undefined) {
        check?.(replay);
        return { result: replay, event: null };
      }
      const written = write();
      storeResult(tx, actor.id, idem, written.result);
      return written;
    });
  }

  /**
   * The product with this id, or else this key (in any case), among those the
   * actor's product grant covers: the products whose every item it reaches.
   */
  function resolveProduct(
    tx: Tx | Db,
    ref: string,
    actor: ActingActor,
  ): Product {
    try {
      return findProduct(
        tx,
        ref,
        amongProducts(product.id, productIdsOf(actor)),
      );
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      const named = namedOnly(tx, ref, actor);
      if (!named) throw error;
      const slugs = projectsDrawingFrom(tx, actor, named.id).map((p) => p.slug);
      if (slugs.length === 0) {
        const via = implicitProjectsOf(tx, actor, named.id).map((p) => p.slug);
        throw new NotFoundError(
          `this key reads product ${named.key} only through ${projectList(via)}, which reaches ${via.length === 1 ? `${via[0]}'s` : "their"} ${named.key} items to read and comment on: anything on ${named.key} itself needs a key that lists ${named.key}`,
        );
      }
      throw new NotFoundError(
        `this key reaches product ${named.key} only through ${projectList(slugs)}: send ${projectArgs(slugs)} in place of product (file_issue takes both, to file into ${named.key} within the project); anything else on ${named.key} itself needs a key that lists ${named.key}`,
      );
    }
  }

  /** The product the actor may name but whose items it reaches only through its projects; undefined for any other ref. */
  function namedOnly(
    tx: Tx | Db,
    ref: string,
    actor: ActingActor,
  ): Product | undefined {
    try {
      const named = resolveNamedProduct(tx, ref, actor);
      return grantsProduct(actor, named.id) ? undefined : named;
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      return undefined;
    }
  }

  /** The actor's own projects that draw from the product, A to Z by slug. */
  function projectsDrawingFrom(
    tx: Tx | Db,
    actor: ActingActor,
    productId: string,
  ): ProjectRow[] {
    const own = actor.scope?.projects.map((p) => p.id) ?? [];
    if (own.length === 0) return [];
    return tx
      .select(getTableColumns(project))
      .from(project)
      .innerJoin(projectProduct, eq(projectProduct.projectId, project.id))
      .where(
        and(inArray(project.id, own), eq(projectProduct.productId, productId)),
      )
      .orderBy(project.slug)
      .all();
  }

  /**
   * The projects, A to Z by slug, whose items a bot reads without listing
   * them: those drawing from one of its own products; with `productId`, only
   * those drawing from that product too.
   */
  function implicitProjectsOf(
    tx: Tx | Db,
    actor: ActingActor,
    productId?: string,
  ): ProjectRow[] {
    const reach = reachFor(actor);
    if (reach === null || !reach.implicitProjects) return [];
    return tx
      .select()
      .from(project)
      .where(
        and(
          notInArray(project.id, [...reach.projects]),
          projectsReached(db, { ...reach, projects: [] }),
          productId === undefined
            ? undefined
            : inArray(
                project.id,
                tx
                  .select({ id: projectProduct.projectId })
                  .from(projectProduct)
                  .where(eq(projectProduct.productId, productId)),
              ),
        ),
      )
      .orderBy(project.slug)
      .all();
  }

  /** "Ask alpha, the owner of ATL, for that grant.", or the key's minter when the product has no owner. */
  function askForGrant(tx: Tx | Db, named: Product): string {
    const owner =
      named.ownerId === null
        ? undefined
        : actorRefs(tx, [named.ownerId]).get(named.ownerId)?.name;
    return owner === undefined
      ? "Ask whoever minted the key for that grant."
      : `Ask ${owner}, the owner of ${named.key}, for that grant.`;
  }

  /**
   * Refuses filing on `named` when the actor reaches it only through
   * projects drawing from its own products: that read gives no filing.
   */
  function requireFilingGrant(
    tx: Tx,
    actor: ActingActor,
    named: Product,
    item: "issue" | "note",
  ) {
    if (grantsProduct(actor, named.id)) return;
    if (projectsDrawingFrom(tx, actor, named.id).length > 0) return;
    const via = implicitProjectsOf(tx, actor, named.id);
    const slugs = via.map((p) => p.slug);
    const own = tx
      .selectDistinct({ key: product.key })
      .from(product)
      .innerJoin(projectProduct, eq(projectProduct.productId, product.id))
      .where(
        and(
          inArray(
            projectProduct.projectId,
            via.map((p) => p.id),
          ),
          amongProducts(product.id, productIdsOf(actor)),
        ),
      )
      .orderBy(product.key)
      .all()
      .map((p) => p.key);
    const fileOn = own.length === 1 ? own[0] : `one of ${andList(own)}`;
    const into =
      slugs.length === 1
        ? `with project: "${slugs[0]}" to put the ${item} in ${slugs[0]}`
        : `with ${projectArgs(slugs)} to put the ${item} in that project`;
    const refused =
      item === "note"
        ? `add no notes on ${named.key}: add the note on ${fileOn}`
        : `file nothing on ${named.key}: file on ${fileOn}`;
    throw new ForbiddenScopeError(
      `this key reads product ${named.key} only through ${projectList(slugs)}, which lets it read ${slugs.length === 1 ? `${slugs[0]}'s` : "their"} ${named.key} items and comment on them and ${refused} (${into}), or get a key that lists ${grantsFor(named.key, slugs)}. ${askForGrant(tx, named)}`,
    );
  }

  /** `resolveProduct` among the products the actor may name, which adds those its projects draw from. */
  function resolveNamedProduct(
    tx: Tx | Db,
    ref: string,
    actor: ActingActor,
  ): Product {
    return findProduct(tx, ref, productsNamed(db, reachFor(actor), product.id));
  }

  /**
   * `resolveNamedProduct` without the products named only through the implicit
   * read, which shows their name and key and never their labels: one of those
   * is a 404 naming the projects that show it and the grants that would list its labels.
   */
  function resolveLabeledProduct(
    tx: Tx | Db,
    ref: string,
    actor: ActingActor,
  ): Product {
    const reach = reachFor(actor);
    try {
      return findProduct(
        tx,
        ref,
        productsNamed(
          db,
          reach && { ...reach, implicitProjects: false },
          product.id,
        ),
      );
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      let named: Product;
      try {
        named = resolveNamedProduct(tx, ref, actor);
      } catch (unnamed) {
        throw unnamed instanceof NotFoundError ? error : unnamed;
      }
      const via = implicitProjectsOf(tx, actor, named.id).map((p) => p.slug);
      if (via.length === 0) throw error;
      throw new NotFoundError(
        `this key reads only the name and key of product ${named.key}, through ${projectList(via)}: ${named.key}'s labels need a key that lists ${grantsFor(named.key, via)}. ${askForGrant(tx, named)}`,
      );
    }
  }

  function findProduct(
    tx: Tx | Db,
    ref: string,
    visible: SQL | undefined,
  ): Product {
    const found =
      tx
        .select()
        .from(product)
        .where(and(eq(product.id, ref), visible))
        .get() ??
      tx
        .select()
        .from(product)
        .where(and(eq(product.key, ref.trim().toUpperCase()), visible))
        .get();
    if (!found) throw noProduct(ref);
    return found;
  }

  /** The actor's projects and those drawing from one of its products; every project for an unrestricted actor. */
  function reachableProjects(actor: ActingActor): SQL | undefined {
    return projectsReached(db, reachFor(actor));
  }

  /** The project with exactly this slug, among those the actor reaches. */
  function findProject(
    tx: Tx | Db,
    slug: string,
    actor: ActingActor,
  ): ProjectRow | undefined {
    return tx
      .select()
      .from(project)
      .where(and(eq(project.slug, slug.trim()), reachableProjects(actor)))
      .get();
  }

  /**
   * The project with exactly this slug. A product key gets a 404 pointing to
   * the caller's product argument, or, for a caller with none, saying that
   * `slugOnly` (its tool and route) takes a project's slug.
   */
  function resolveProject(
    tx: Tx | Db,
    slug: string,
    actor: ActingActor,
    slugOnly?: string,
  ): ProjectRow {
    const found = findProject(tx, slug, actor);
    if (found) return found;
    let named: Product | undefined;
    try {
      named = resolveNamedProduct(tx, slug, actor);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    // items carry their product's key as project, so a bot reading one sends it here
    if (named) {
      throw new NotFoundError(
        slugOnly === undefined
          ? `no project ${slug}: that is a product key, send it as product (product: "${named.key}")`
          : `no project ${slug}: that is a product key, and ${slugOnly} takes a project's slug; list_projects (GET /projects) lists them`,
      );
    }
    throw noProject(slug);
  }

  /**
   * A project by exact slug, else a product by key or id (the meaning
   * `project` had before projects). A slug matching a product's key predates
   * the rule keeping them apart; the project wins, and the key in upper case,
   * which no slug matches, still reaches the product.
   */
  function resolveProjectOrProduct(
    tx: Tx | Db,
    ref: string,
    actor: ActingActor,
  ): { project: ProjectRow } | { product: Product } {
    const found = findProject(tx, ref, actor);
    if (found) return { project: found };
    try {
      return { product: resolveNamedProduct(tx, ref, actor) };
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
    throw noProject(ref);
  }

  /**
   * The item the actor sees with this id, else this key (TRL-12, the product
   * key in any case), else this source key (ABC-187, any case): a trail key
   * wins over a source key that looks the same. Only visible items are
   * searched, so a hidden one shadows nothing.
   */
  function resolveIssueRow(
    tx: Tx | Db,
    ref: string,
    actor: ActingActor,
  ): IssueRow {
    const visible = itemsReached(
      db,
      reachFor(actor),
      issue.id,
      issue.productId,
    );
    const byId = tx
      .select()
      .from(issue)
      .where(and(eq(issue.id, ref), visible))
      .get();
    if (byId) return byId;
    const match = issueKeyPattern.exec(ref.trim());
    const byKey =
      match &&
      tx
        .select({ issue })
        .from(issue)
        .innerJoin(product, eq(product.id, issue.productId))
        .where(
          and(
            eq(product.key, (match[1] as string).toUpperCase()),
            eq(issue.number, Number(match[2])),
            visible,
          ),
        )
        .get()?.issue;
    if (byKey) return byKey;
    const bySourceKey = tx
      .select()
      .from(issue)
      .where(and(eq(issue.sourceKey, ref.trim().toUpperCase()), visible))
      .get();
    if (!bySourceKey) throw noIssue(ref);
    return bySourceKey;
  }

  /** These actors as rows name them, by id. */
  function actorRefs(tx: Tx | Db, ids: (string | null)[]) {
    const wanted = [...new Set(ids.filter((id) => id !== null))];
    const rows =
      wanted.length === 0
        ? []
        : tx
            .select({
              id: actorTable.id,
              name: actorTable.displayName,
              kind: actorTable.kind,
            })
            .from(actorTable)
            .where(inArray(actorTable.id, wanted))
            .all();
    return new Map<string, ActorRef>(rows.map((r) => [r.id, r]));
  }

  /** Each row with its keys, labels, links, assignee and the projects `actor` reaches, in the order given. */
  function hydrate(tx: Tx | Db, rows: IssueRow[], actor: ActingActor): Issue[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const keys = new Map(
      tx
        .select({ id: product.id, key: product.key })
        .from(product)
        .where(inArray(product.id, [...new Set(rows.map((r) => r.productId))]))
        .all()
        .map((p) => [p.id, p.key]),
    );
    const labels = tx
      .select({ issueId: issueLabel.issueId, name: label.name })
      .from(issueLabel)
      .innerJoin(label, eq(label.id, issueLabel.labelId))
      .where(inArray(issueLabel.issueId, ids))
      .orderBy(asc(label.name))
      .all();
    // rowid is insertion order, and setLinks rewrites an issue's links in the order given
    const links = tx
      .select({
        issueId: issueLink.issueId,
        url: issueLink.url,
        title: issueLink.title,
      })
      .from(issueLink)
      .where(inArray(issueLink.issueId, ids))
      .orderBy(sql`rowid`)
      .all();
    const projects = projectsSeenBy(tx, ids, actor);
    const assignees = actorRefs(
      tx,
      rows.map((r) => r.assigneeId),
    );
    const about = aboutOf(
      tx,
      rows.filter((r) => r.type === "note").map((r) => r.id),
      actor,
    );
    return rows.map((row) => ({
      ...row,
      key: `${keys.get(row.productId)}-${row.number}`,
      productKey: keys.get(row.productId) as string,
      labels: labels.filter((l) => l.issueId === row.id).map((l) => l.name),
      links: links
        .filter((l) => l.issueId === row.id)
        .map(({ url, title }) => ({ url, title })),
      assignee:
        row.assigneeId === null
          ? null
          : (assignees.get(row.assigneeId) ?? null),
      projects: projects
        .filter((p) => p.issueId === row.id)
        .map(({ slug, name }) => ({ slug, name })),
      ...(row.type === "note" && { about: about.get(row.id) ?? [] }),
    }));
  }

  /** The items with each pull request link's cached state as its pr, which also queues a refresh of a stale one. */
  function withPullRequests<T extends Pick<Issue, "links">>(items: T[]): T[] {
    const states = pullRequests.read(
      items.flatMap((item) => item.links.map((l) => l.url)),
    );
    return items.map((item) => ({
      ...item,
      links: item.links.map((l) =>
        states.has(l.url) ? { ...l, pr: states.get(l.url) ?? null } : l,
      ),
    }));
  }

  const withPullRequest = <T extends Pick<Issue, "links">>(item: T) =>
    withPullRequests([item])[0] as T;

  /** The projects of these items the actor reaches, in slug order. */
  const projectsSeenBy = (tx: Tx | Db, ids: string[], actor: ActingActor) =>
    tx
      .select({
        issueId: projectItem.issueId,
        slug: project.slug,
        name: project.name,
      })
      .from(projectItem)
      .innerJoin(project, eq(project.id, projectItem.projectId))
      .where(and(inArray(projectItem.issueId, ids), reachableProjects(actor)))
      .orderBy(asc(project.slug))
      .all();

  const hydrateOne = (tx: Tx | Db, row: IssueRow, actor: ActingActor) =>
    hydrate(tx, [row], actor)[0] as Issue;

  const itemRefColumns = {
    key: sql<string>`${product.key} || '-' || ${issue.number}`,
    title: issue.title,
    type: issue.type,
    status: issue.status,
  };

  /** The items each of these notes is about that `actor` reaches, by note id, in key order. */
  function aboutOf(
    tx: Tx | Db,
    noteIds: string[],
    actor: ActingActor,
  ): Map<string, ItemRef[]> {
    const about = new Map<string, ItemRef[]>();
    if (noteIds.length === 0) return about;
    for (const { noteId, ...ref } of tx
      .select({ noteId: noteAbout.noteId, ...itemRefColumns })
      .from(noteAbout)
      .innerJoin(issue, eq(issue.id, noteAbout.itemId))
      .innerJoin(product, eq(product.id, issue.productId))
      .where(
        and(
          inArray(noteAbout.noteId, noteIds),
          itemsReached(db, reachFor(actor), issue.id, issue.productId),
        ),
      )
      .orderBy(asc(product.key), asc(issue.number))
      .all()) {
      about.set(noteId, [...(about.get(noteId) ?? []), ref]);
    }
    return about;
  }

  /**
   * A note's about as its events carry it: the keys of the items in the note's
   * own product, in key order, and a count of the rest, since anyone who sees
   * the note's events may not reach another product's items.
   */
  function aboutInEvents(
    tx: Tx,
    noteId: string,
    noteProductId: string,
  ): { keys: string[]; others: number } {
    const items = tx
      .select({ key: itemRefColumns.key, productId: issue.productId })
      .from(noteAbout)
      .innerJoin(issue, eq(issue.id, noteAbout.itemId))
      .innerJoin(product, eq(product.id, issue.productId))
      .where(eq(noteAbout.noteId, noteId))
      .orderBy(asc(product.key), asc(issue.number))
      .all();
    const keys = items
      .filter((i) => i.productId === noteProductId)
      .map((i) => i.key);
    return { keys, others: items.length - keys.length };
  }

  /** Where a note is about the item and `actor` reaches the note. */
  const reachedNotesAbout = (itemId: string, actor: ActingActor) =>
    and(
      eq(noteAbout.itemId, itemId),
      itemsReached(db, reachFor(actor), issue.id, issue.productId),
    );

  /** The newest `ITEM_NOTES_MAX` current notes about the item that `actor` reaches, newest first. */
  function notesAbout(
    tx: Tx | Db,
    itemId: string,
    actor: ActingActor,
  ): ItemRef[] {
    return tx
      .select(itemRefColumns)
      .from(noteAbout)
      .innerJoin(issue, eq(issue.id, noteAbout.noteId))
      .innerJoin(product, eq(product.id, issue.productId))
      .where(and(reachedNotesAbout(itemId, actor), eq(issue.status, "current")))
      .orderBy(desc(issue.createdAt), desc(issue.id))
      .limit(ITEM_NOTES_MAX)
      .all();
  }

  /** The item list_items' `about` names; one `actor` doesn't reach is a bad query, named. */
  function aboutTarget(ref: string, actor: ActingActor): IssueRow {
    try {
      return resolveIssueRow(db, ref, actor);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      throw new ValidationError(
        `about names ${ref}, which this key doesn't reach or which doesn't exist: send the key, like TRL-12, of an item get_item finds`,
      );
    }
  }

  /** Every note about the item that `actor` reaches, per status. */
  function notesCountAbout(
    tx: Tx | Db,
    itemId: string,
    actor: ActingActor,
  ): NoteCounts {
    const counts = noNotes();
    for (const { status, n } of tx
      .select({ status: issue.status, n: sql<number>`count(*)` })
      .from(noteAbout)
      .innerJoin(issue, eq(issue.id, noteAbout.noteId))
      .where(reachedNotesAbout(itemId, actor))
      .groupBy(issue.status)
      .all()) {
      if (isNoteStatus(status)) counts[status] = n;
    }
    return counts;
  }

  /** `about` as sent, checked for count before any lookup. */
  function validAbout(refs: string[], field: string): string[] {
    if (refs.length > NOTE_ABOUT_MAX) {
      throw new ValidationError(
        `${field} names ${refs.length} items, over the limit of ${NOTE_ABOUT_MAX}: a note is about at most ${NOTE_ABOUT_MAX} items`,
      );
    }
    return refs.map((ref) => nonBlank(ref, field));
  }

  /**
   * The items these keys name, once each, among those `actor` reaches; one it
   * doesn't is a bad field in the body, named, and so is the note itself.
   */
  function aboutRows(
    tx: Tx,
    actor: ActingActor,
    refs: string[],
    field: string,
    noteId?: string,
  ): IssueRow[] {
    const rows = new Map<string, IssueRow>();
    for (const ref of refs) {
      let row: IssueRow;
      try {
        row = resolveIssueRow(tx, ref, actor);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        throw new ValidationError(
          `${field} names ${ref}, which this key doesn't reach or which doesn't exist: send keys like TRL-12 of items get_item finds`,
        );
      }
      if (row.id === noteId) {
        throw new ValidationError(
          `${field} names ${ref}, the note itself: a note is about other items`,
        );
      }
      rows.set(row.id, row);
    }
    return [...rows.values()];
  }

  /**
   * The ids of the items the note is about after an update's `replace`
   * (about), `add` and `remove`, or undefined when they stay as they are; an
   * item turned into work keeps none. A replace keeps the items the caller
   * doesn't reach, which it can't name; `remove` ignores a key it can't find.
   */
  function wantedAbout(
    tx: Tx,
    actor: ActingActor,
    row: IssueRow,
    type: IssueType,
    forms: { replace?: string[]; add?: string[]; remove?: string[] },
  ): string[] | undefined {
    const stored = tx
      .select({ id: noteAbout.itemId })
      .from(noteAbout)
      .where(eq(noteAbout.noteId, row.id))
      .all()
      .map((r) => r.id);
    const idsOf = (refs: string[], field: string) =>
      aboutRows(tx, actor, refs, field, row.id).map((r) => r.id);
    const unreached = () => {
      const reached = new Set(
        tx
          .select({ id: issue.id })
          .from(issue)
          .where(
            and(
              inArray(issue.id, stored),
              itemsReached(db, reachFor(actor), issue.id, issue.productId),
            ),
          )
          .all()
          .map((r) => r.id),
      );
      return stored.filter((id) => !reached.has(id));
    };
    let kept: string[];
    let added: string[] = [];
    if (type !== "note") {
      kept = [];
    } else if (forms.replace !== undefined) {
      kept = unreached();
      added = idsOf(forms.replace, "about");
    } else if (forms.add !== undefined || forms.remove !== undefined) {
      const removed = new Set(
        (forms.remove ?? []).flatMap((ref) => {
          try {
            return [resolveIssueRow(tx, ref, actor).id];
          } catch (error) {
            if (error instanceof NotFoundError) return [];
            throw error;
          }
        }),
      );
      kept = stored.filter((id) => !removed.has(id));
      added = idsOf(forms.add ?? [], "addAbout");
    } else {
      return undefined;
    }
    const wanted = [...new Set([...kept, ...added])];
    if (wanted.length > NOTE_ABOUT_MAX) {
      // both forms keep every stored item the key can't reach
      const out = unreached().length;
      const total = `a note is about at most ${NOTE_ABOUT_MAX} items, and this update would make it about ${wanted.length}`;
      throw new ValidationError(
        out === 0
          ? `${total}: drop some with removeAbout`
          : `${total}, ${out} of them out of this key's reach, which it keeps and removeAbout can't drop: leave it about at most ${Math.max(NOTE_ABOUT_MAX - out, 0)} items this key reaches`,
      );
    }
    const same =
      wanted.length === stored.length &&
      wanted.every((id) => stored.includes(id));
    return same ? undefined : wanted;
  }

  /**
   * Refuses an edit to a note from anyone but its author and its product's
   * own bot: anyone else who reaches it comments.
   */
  function requireNoteEdit(
    tx: Tx | Db,
    actor: ActingActor,
    row: IssueRow,
    key: string,
  ): void {
    const ownerId = ownerIdOf(tx, row.productId);
    if (actor.id === row.createdBy || actor.id === ownerId) return;
    const names = actorRefs(tx, [row.createdBy, ownerId]);
    const authorRef = names.get(row.createdBy);
    const author = authorRef?.name ?? "its author";
    // a person authors a note only by filing the issue it was turned from, and people edit nothing over the API
    const authorEdits = authorRef?.kind !== "human";
    const owner =
      ownerId === null
        ? undefined
        : `${names.get(ownerId)?.name ?? "its owner"}, the bot of ${key.slice(0, key.lastIndexOf("-"))}`;
    const editors =
      owner === undefined || ownerId === row.createdBy
        ? authorEdits
          ? `only ${author} edits it`
          : "no bot edits it"
        : authorEdits
          ? `only ${author} and ${owner}, edit it`
          : `only ${owner}, edits it`;
    throw new ForbiddenError(
      `${key} is a note by ${author}, and ${editors}: add what you know with add_comment on ${key}`,
    );
  }

  /** `resolveIssueRow` among issues and todos: what the routes from before notes find. */
  function workRow(tx: Tx | Db, ref: string, actor: ActingActor): IssueRow {
    const row = resolveIssueRow(tx, ref, actor);
    if (row.type !== "note") return row;
    const productKey = tx
      .select({ key: product.key })
      .from(product)
      .where(eq(product.id, row.productId))
      .get()?.key;
    throw noteOnIssueRoute(`${productKey}-${row.number}`);
  }

  /** Replaces the items the note is about. */
  function setAbout(tx: Tx, noteId: string, itemIds: string[]): void {
    tx.delete(noteAbout).where(eq(noteAbout.noteId, noteId)).run();
    if (itemIds.length === 0) return;
    tx.insert(noteAbout)
      .values(itemIds.map((itemId) => ({ noteId, itemId })))
      .run();
  }

  /** Why the actor reaches `row`, an item it reaches; see `ItemAccess`. */
  function accessOf(
    tx: Tx | Db,
    actor: ActingActor,
    row: IssueRow,
  ): ItemAccess {
    if (grantsProduct(actor, row.productId)) return "product";
    const listed = projectIdsOf(actor) ?? [];
    const inListed =
      listed.length > 0 &&
      tx
        .select({ one: sql`1` })
        .from(projectItem)
        .where(
          and(
            eq(projectItem.issueId, row.id),
            inArray(projectItem.projectId, [...listed]),
          ),
        )
        .get() !== undefined;
    return inListed ? "project" : "via_project";
  }

  /**
   * Refuses, with `refusal` of the product's key and whom to ask, an actor
   * whose key doesn't list the product and who isn't the product's owner.
   */
  function requireProductGrant(
    tx: Tx | Db,
    actor: ActingActor,
    productId: string,
    refusal: (productKey: string) => string,
  ): void {
    if (grantsProduct(actor, productId)) return;
    const target = tx
      .select()
      .from(product)
      .where(eq(product.id, productId))
      .get() as Product;
    if (target.ownerId === actor.id) return;
    throw new ForbiddenScopeError(
      `${refusal(target.key)} ${askForGrant(tx, target)}`,
    );
  }

  /**
   * Refuses `doing` on `row` when the actor reaches it only through a project
   * drawing from its products: such a key reads the item and comments on it,
   * and the 403 names the projects, the grants that would allow it and whom
   * to ask.
   */
  function requireItemWrite(
    tx: Tx | Db,
    actor: ActingActor,
    row: IssueRow,
    doing: string,
  ): void {
    if (accessOf(tx, actor, row) !== "via_project") return;
    const target = tx
      .select()
      .from(product)
      .where(eq(product.id, row.productId))
      .get() as Product;
    const slugs = tx
      .select({ slug: project.slug })
      .from(projectItem)
      .innerJoin(project, eq(project.id, projectItem.projectId))
      .where(and(eq(projectItem.issueId, row.id), reachableProjects(actor)))
      .orderBy(asc(project.slug))
      .all()
      .map((p) => p.slug);
    throw new ForbiddenScopeError(
      `${target.key}-${row.number} is visible to this key only through ${projectList(slugs)}, which lets it read the item and comment on it (add_comment) and nothing else: to ${doing}, the bot needs a key that lists ${grantsFor(target.key, slugs)}. ${askForGrant(tx, target)}`,
    );
  }

  /**
   * The actor `ref` names to assign: any actor by id, else the bot with this
   * name ignoring the case of A-Z. An unknown one is a bad field in the body,
   * not a missing target.
   */
  function resolveAssignee(
    tx: Tx | Db,
    ref: string,
    use = "to assign",
  ): string {
    const found =
      tx
        .select({ id: actorTable.id })
        .from(actorTable)
        .where(eq(actorTable.id, ref))
        .get() ??
      tx
        .select({ id: actorTable.id })
        .from(actorTable)
        .where(
          and(
            eq(actorTable.kind, "bot"),
            sql`lower(${actorTable.displayName}) = lower(${ref.trim()})`,
          ),
        )
        .get();
    if (!found) {
      throw new ValidationError(
        `no bot or person ${ref} ${use}: pass a bot's name or id (list_bots lists them) or a person's id`,
      );
    }
    return found.id;
  }

  /** The bot `ref` names by id or by name ignoring the case of A-Z, for `field`; a person or an unknown name is a 422. */
  function resolveBot(tx: Tx | Db, ref: string, field: string): Actor {
    const found =
      tx.select().from(actorTable).where(eq(actorTable.id, ref)).get() ??
      tx
        .select()
        .from(actorTable)
        .where(
          and(
            eq(actorTable.kind, "bot"),
            sql`lower(${actorTable.displayName}) = lower(${ref.trim()})`,
          ),
        )
        .get();
    if (!found) {
      throw new ValidationError(
        `${field} names no bot ${ref}: pass a bot's name or id (list_bots lists them, and whoami gives your own)`,
      );
    }
    if (found.kind !== "bot") {
      throw new ValidationError(
        `${field} must be a bot, and ${ref} is a person: pass a bot's name or id`,
      );
    }
    return found;
  }

  /** The products the actor owns among those it reaches, A to Z by key. */
  function ownProductsOf(tx: Tx | Db, actor: ActingActor): Product[] {
    return tx
      .select()
      .from(product)
      .where(
        and(
          eq(product.ownerId, actor.id),
          amongProducts(product.id, productIdsOf(actor)),
        ),
      )
      .orderBy(asc(product.key))
      .all();
  }

  /** The products the actor's product grant covers, A to Z by key. */
  function grantedProducts(tx: Tx | Db, actor: ActingActor): Product[] {
    return tx
      .select()
      .from(product)
      .where(amongProducts(product.id, productIdsOf(actor)))
      .orderBy(asc(product.key))
      .all();
  }

  /**
   * The products the actor files issues on, A to Z by key: its own grant's,
   * and those the projects it lists draw from; not those it names only
   * through its implicit project read.
   */
  function fileableProducts(tx: Tx | Db, actor: ActingActor): Product[] {
    const reach = reachFor(actor);
    return tx
      .select()
      .from(product)
      .where(
        productsNamed(
          db,
          reach && { ...reach, implicitProjects: false },
          product.id,
        ),
      )
      .orderBy(asc(product.key))
      .all();
  }

  /**
   * The caller's one own product, for a write that names none; with none or
   * several, a 422 listing the products to pick from: its own when it has
   * several, else every one it reaches.
   */
  function defaultProduct(
    tx: Tx | Db,
    actor: ActingActor,
    doing: string,
    field: "product" | "products" = "product",
  ) {
    const own = ownProductsOf(tx, actor);
    if (own.length === 1) return own[0] as Product;
    const choices = own.length > 1 ? own : grantedProducts(tx, actor);
    const keys = choices.map((p) => p.key);
    const listed =
      keys.length === 0
        ? "this key reaches no product"
        : field === "product"
          ? `pick one of ${andList(keys)}`
          : `send products with one or more of ${andList(keys)}`;
    throw new ValidationError(
      own.length > 1
        ? `you own ${keys.length} products, so ${doing} needs ${field}: ${listed}`
        : `you own no product, so ${doing} needs ${field}: ${listed} (list_products describes each)`,
    );
  }

  function ownerIdOf(tx: Tx | Db, productId: string): string | null {
    return (
      tx
        .select({ ownerId: product.ownerId })
        .from(product)
        .where(eq(product.id, productId))
        .get()?.ownerId ?? null
    );
  }

  /**
   * Refuses `actor` a write only the product's owner makes, unless the product
   * has no owner or `actor` is it; `refusal` words the 403 from the owner's name.
   */
  function requireOwner(
    tx: Tx | Db,
    actor: ActingActor,
    productId: string,
    refusal: (owner: string, productKey: string) => string,
  ): void {
    const target = tx
      .select({ key: product.key, ownerId: product.ownerId })
      .from(product)
      .where(eq(product.id, productId))
      .get() as { key: string; ownerId: string | null };
    if (target.ownerId === null || target.ownerId === actor.id) return;
    const owner = actorRefs(tx, [target.ownerId]).get(target.ownerId);
    throw new ForbiddenError(refusal(owner?.name ?? "its owner", target.key));
  }

  function productView(tx: Tx | Db, row: Product): ProductView {
    return productViews(tx, [row])[0] as ProductView;
  }

  /** `productView` of each row, in order, in one query however many rows. */
  function productViews(tx: Tx | Db, rows: Product[]): ProductView[] {
    const owners = actorRefs(
      tx,
      rows.map((r) => r.ownerId),
    );
    return rows.map((row) => ({
      ...row,
      owner: row.ownerId === null ? null : (owners.get(row.ownerId) ?? null),
    }));
  }

  /** Each row as the actor reads it, in order: whole where its product grant covers it, else named only. */
  function productReads(
    actor: ActingActor,
    rows: Product[],
  ): (ProductView | NamedProduct)[] {
    const granted = new Map(
      productViews(
        db,
        rows.filter((r) => grantsProduct(actor, r.id)),
      ).map((v) => [v.id, v]),
    );
    return rows.map(
      (row) =>
        granted.get(row.id) ?? { id: row.id, key: row.key, name: row.name },
    );
  }

  function statusUpdateViews(
    tx: Tx | Db,
    rows: (
      | typeof productStatusUpdate.$inferSelect
      | typeof projectStatusUpdate.$inferSelect
    )[],
  ): StatusUpdate[] {
    const productKeys = new Map(
      tx
        .select({ id: product.id, key: product.key })
        .from(product)
        .where(
          inArray(product.id, [
            ...new Set(
              rows.flatMap((r) => ("productId" in r ? [r.productId] : [])),
            ),
          ]),
        )
        .all()
        .map((p) => [p.id, p.key]),
    );
    const slugs = new Map(
      tx
        .select({ id: project.id, slug: project.slug })
        .from(project)
        .where(
          inArray(project.id, [
            ...new Set(
              rows.flatMap((r) => ("projectId" in r ? [r.projectId] : [])),
            ),
          ]),
        )
        .all()
        .map((p) => [p.id, p.slug]),
    );
    return rows.map((r) => ({
      id: r.id,
      productId: "productId" in r ? r.productId : null,
      productKey:
        "productId" in r ? (productKeys.get(r.productId) ?? null) : null,
      projectId: "projectId" in r ? r.projectId : null,
      projectSlug: "projectId" in r ? (slugs.get(r.projectId) ?? null) : null,
      authorId: r.authorId,
      body: r.body,
      health: r.health,
      externalRef: "externalRef" in r ? r.externalRef : null,
      sourceAuthor: "sourceAuthor" in r ? r.sourceAuthor : null,
      createdAt: r.createdAt,
    }));
  }

  /** The project as `actor` sees it; see `ProjectView`. */
  function projectView(
    tx: Tx | Db,
    row: ProjectRow,
    actor: ActingActor,
  ): ProjectView {
    return projectViews(tx, [row], actor)[0] as ProjectView;
  }

  const noItems = (): ItemCounts => ({
    triage: 0,
    open: 0,
    in_progress: 0,
    done: 0,
    canceled: 0,
  });
  const noNotes = (): NoteCounts => ({ current: 0, archived: 0 });

  /** `projectView` of each row, in order, in a fixed number of queries however many rows. */
  function projectViews(
    tx: Tx | Db,
    rows: ProjectRow[],
    actor: ActingActor,
  ): ProjectView[] {
    if (rows.length === 0) return [];
    const projectIds = rows.map((r) => r.id);
    const reach = reachFor(actor);
    const named =
      reach === null
        ? null
        : new Set(
            tx
              .select({ id: product.id })
              .from(product)
              .where(productsNamed(db, reach, product.id))
              .all()
              .map((p) => p.id),
          );
    const productsOf = new Map<
      string,
      { id: string; key: string; name: string }[]
    >();
    for (const { projectId, ...p } of tx
      .select({
        projectId: projectProduct.projectId,
        id: product.id,
        key: product.key,
        name: product.name,
      })
      .from(projectProduct)
      .innerJoin(product, eq(product.id, projectProduct.productId))
      .where(inArray(projectProduct.projectId, projectIds))
      .orderBy(asc(product.key))
      .all()) {
      productsOf.set(projectId, [...(productsOf.get(projectId) ?? []), p]);
    }
    const countsOf = new Map<string, ItemCounts>();
    const notesOf = new Map<string, NoteCounts>();
    for (const { projectId, status, n } of tx
      .select({
        projectId: projectItem.projectId,
        status: issue.status,
        n: sql<number>`count(*)`,
      })
      .from(projectItem)
      .innerJoin(issue, eq(issue.id, projectItem.issueId))
      .where(
        and(
          inArray(projectItem.projectId, projectIds),
          itemsReached(db, reach, projectItem.issueId, projectItem.productId),
        ),
      )
      .groupBy(projectItem.projectId, issue.status)
      .all()) {
      if (isNoteStatus(status)) {
        const notes = notesOf.get(projectId) ?? noNotes();
        notes[status] = n;
        notesOf.set(projectId, notes);
        continue;
      }
      const counts = countsOf.get(projectId) ?? noItems();
      counts[status] = n;
      countsOf.set(projectId, counts);
    }
    const latestRows = tx
      .select()
      .from(projectStatusUpdate)
      .where(
        and(
          inArray(projectStatusUpdate.projectId, projectIds),
          sql`${projectStatusUpdate.id} = (select s.id from project_status_update s where s.project_id = ${projectStatusUpdate.projectId} order by s.created_at desc, s.id desc limit 1)`,
        ),
      )
      .all();
    const latestViews = statusUpdateViews(tx, latestRows);
    const latestOf = new Map(
      latestRows.map((r, i) => [r.projectId, latestViews[i] as StatusUpdate]),
    );
    const refs = actorRefs(tx, [
      ...rows.map((r) => r.leadId),
      ...latestRows.map((r) => r.authorId),
    ]);
    return rows.map((row) => {
      const all = productsOf.get(row.id) ?? [];
      const products = all.filter((p) => named === null || named.has(p.id));
      const latest = latestOf.get(row.id);
      return {
        ...row,
        lead: refs.get(row.leadId) as ActorRef,
        products,
        hiddenProducts: products.length < all.length,
        counts: countsOf.get(row.id) ?? noItems(),
        notes: notesOf.get(row.id) ?? noNotes(),
        latestStatusUpdate: latest
          ? { ...latest, author: refs.get(latest.authorId) as ActorRef }
          : null,
      };
    });
  }

  function findLabel(tx: Tx, projectId: string, name: string) {
    return tx
      .select()
      .from(label)
      .where(
        and(
          eq(label.productId, projectId),
          sql`${label.name} = ${name} collate nocase`,
        ),
      )
      .get();
  }

  /** The product's labels by these names, matched ignoring the case of A-Z, created when missing. */
  function labelsNamed(tx: Tx, projectId: string, names: string[]): Label[] {
    return names.map(
      (name) =>
        findLabel(tx, projectId, name) ??
        tx
          .insert(label)
          .values({ productId: projectId, name })
          .returning()
          .get(),
    );
  }

  function setLabels(tx: Tx, target: IssueRow, labels: Label[]): void {
    tx.delete(issueLabel).where(eq(issueLabel.issueId, target.id)).run();
    if (labels.length === 0) return;
    tx.insert(issueLabel)
      .values(
        labels.map((l) => ({
          issueId: target.id,
          labelId: l.id,
          productId: target.productId,
        })),
      )
      .run();
  }

  function setLinks(tx: Tx, issueId: string, links: Link[]): void {
    tx.delete(issueLink).where(eq(issueLink.issueId, issueId)).run();
    if (links.length === 0) return;
    tx.insert(issueLink)
      .values(links.map((l) => ({ issueId, ...l })))
      .run();
  }

  /** The product's next issue number, handed out in this transaction. */
  function nextIssueNumber(tx: Tx, projectId: string): number {
    const { issueSeq } = tx
      .update(product)
      .set({
        issueSeq: sql`${product.issueSeq} + 1`,
        // numbering an issue is not an edit to the product
        updatedAt: sql`${product.updatedAt}`,
      })
      .where(eq(product.id, projectId))
      .returning({ issueSeq: product.issueSeq })
      .get() as { issueSeq: number };
    return issueSeq;
  }

  /**
   * The numbers of the issues an import creates, by externalRef. One whose
   * sourceKey, or with none its externalRef, is in the product's own key form
   * (ABC-187) keeps that number, so its key still resolves; the product's
   * sequence moves up to the highest kept, then numbers the rest after it by
   * (createdAt, externalRef), whatever the payload order. One whose number
   * another issue already holds is numbered with the rest and listed in
   * `renumbered` with its new key; its source key is the holder's key, which
   * `resolveIssueRow` matches first, so it resolves to the holder.
   */
  function importNumbers(
    tx: Tx,
    target: Product,
    rows: NormalIssue[],
  ): { numbers: Map<string, number>; renumbered: Renumbered[] } {
    const ownKey = new RegExp(`^${target.key}-([1-9]\\d*)$`);
    const numbers = new Map<string, number>();
    const keptBy = new Map<number, string>();
    const sequenced: NormalIssue[] = [];
    const taken = new Set<string>();
    for (const row of rows) {
      const number = Number(ownKey.exec(row.sourceKey ?? row.externalRef)?.[1]);
      if (!Number.isSafeInteger(number)) {
        sequenced.push(row);
        continue;
      }
      const twin = keptBy.get(number);
      if (twin !== undefined) {
        throw new ValidationError(
          `issues ${twin} and ${row.externalRef} both keep number ${target.key}-${number}: send each issue its own sourceKey`,
        );
      }
      keptBy.set(number, row.externalRef);
      const holder = tx
        .select()
        .from(issue)
        .where(and(eq(issue.productId, target.id), eq(issue.number, number)))
        .get();
      if (holder) {
        taken.add(row.externalRef);
        sequenced.push(row);
        continue;
      }
      numbers.set(row.externalRef, number);
    }
    if (numbers.size > 0) {
      tx.update(product)
        .set({
          issueSeq: sql`max(${product.issueSeq}, ${Math.max(...numbers.values())})`,
          updatedAt: sql`${product.updatedAt}`,
        })
        .where(eq(product.id, target.id))
        .run();
    }
    sequenced.sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.externalRef < b.externalRef ? -1 : 1),
    );
    const renumbered: Renumbered[] = [];
    for (const row of sequenced) {
      const number = nextIssueNumber(tx, target.id);
      numbers.set(row.externalRef, number);
      if (taken.has(row.externalRef)) {
        renumbered.push({
          externalRef: row.externalRef,
          sourceKey: row.sourceKey ?? null,
          key: `${target.key}-${number}`,
        });
      }
    }
    return { numbers, renumbered };
  }

  type Tally = Record<"created" | "updated" | "unchanged", ImportCounts>;

  /** The product with the payload's externalRef, created or brought up to date. */
  function importProjectRow(
    tx: Tx,
    actor: ActingActor,
    input: NormalImport,
    tally: Tally,
  ): Product {
    const existing = tx
      .select()
      .from(product)
      .where(eq(product.externalRef, input.externalRef))
      .get();
    // before any key is checked for a clash, so a hidden product and a new one are refused alike
    const scope = actor.scope;
    const limited = scope?.products;
    if (scope && limited && !limited.some((p) => p.id === existing?.id)) {
      throw new ForbiddenScopeError(
        scope.projects.length === 0
          ? `this key may not import a product outside ${reachOf(scope)}. Ask whoever minted the key for one that lists the product, or no product list.`
          : limited.length === 0
            ? `this key may not import a product: it reaches only ${reachOf(scope)}, and an import needs a key that lists the product. Ask whoever minted the key for one that lists the product, or ${unlimitedKey(scope)}.`
            : `this key may not import a product outside ${reachOf({ ...scope, projects: [] })}: its projects don't count, since an import needs a key that lists the product. Ask whoever minted the key for one that lists the product, or ${unlimitedKey(scope)}.`,
      );
    }
    if (!existing) {
      const taken = tx
        .select()
        .from(product)
        .where(eq(product.key, input.key))
        .get();
      if (taken) {
        throw new ConflictError(
          `product key ${input.key} is taken by ${taken.kind} ${taken.id} ("${taken.name}", externalRef ${taken.externalRef ?? "none"}): send another key for ${input.externalRef}`,
        );
      }
      requireKeyNoSlug(tx, input.key);
      tally.created.projects++;
      return tx
        .insert(product)
        .values({
          externalRef: input.externalRef,
          key: input.key,
          name: input.name,
          description: input.description ?? "",
          createdAt: input.createdAt,
          createdBy: actor.id,
          // the importing bot carries on the product's work, so what it brings in are its todos
          ownerId: actor.id,
        })
        .returning()
        .get();
    }
    requireOwner(
      tx,
      actor,
      existing.id,
      (owner, key) =>
        `${key} is owned by ${owner}, so only ${owner} imports into it: ask ${owner} to run this import, or file the work as issues with file_issue (POST /items with type issue), and ${owner} accepts them from triage`,
    );
    if (existing.key !== input.key) {
      throw new ConflictError(
        `product ${input.externalRef} was imported with key ${existing.key}: send key ${existing.key}, since a product's key never changes`,
      );
    }
    const changed = changedFields(existing, {
      name: input.name,
      description: input.description,
      createdAt: input.createdAt,
    });
    if (isEmpty(changed)) {
      tally.unchanged.projects++;
      return existing;
    }
    tally.updated.projects++;
    return tx
      .update(product)
      .set(changed)
      .where(eq(product.id, existing.id))
      .returning()
      .get() as Product;
  }

  /** The product's labels by `labelKey`: each payload name created when missing, renamed when only its case differs. */
  function importLabels(
    tx: Tx,
    projectId: string,
    names: string[],
    tally: Tally,
  ): Map<string, Label> {
    const labels = new Map<string, Label>();
    for (const name of names) {
      let found = findLabel(tx, projectId, name);
      if (!found) {
        tally.created.labels++;
        found = tx
          .insert(label)
          .values({ productId: projectId, name })
          .returning()
          .get();
      } else if (found.name !== name) {
        // the payload's spelling wins, as it does for every other field
        tally.updated.labels++;
        found = tx
          .update(label)
          .set({ name })
          .where(eq(label.id, found.id))
          .returning()
          .get() as Label;
      } else {
        tally.unchanged.labels++;
      }
      labels.set(labelKey(name), found);
    }
    return labels;
  }

  /** The id of the issue `row` names, created or brought up to date. */
  function importIssue(
    tx: Tx,
    actor: ActingActor,
    target: Product,
    row: NormalIssue,
    current: Issue | undefined,
    /** From `importNumbers`, for a row with no `current`. */
    number: number | undefined,
    labels: Map<string, Label>,
    tally: Tally,
    now: Date,
  ): string {
    // retyped to a note since an earlier run: a note takes no work status or completedAt, and
    // stays the owner's record, so the source no longer writes over it
    if (current?.type === "note") {
      tally.unchanged.issues++;
      return current.id;
    }
    const labelsOf = (names: string[]) =>
      names.map((n) => labels.get(labelKey(n)) as Label);
    const completedAt = completedAtOf(
      row.status,
      row.completedAt ?? current?.completedAt ?? null,
      now,
    );
    if (row.sourceKey !== undefined && row.sourceKey !== current?.sourceKey) {
      const holder = tx
        .select()
        .from(issue)
        .where(eq(issue.sourceKey, row.sourceKey))
        .get();
      if (holder) {
        const visible = productIdsOf(actor);
        // source keys are unique across products, so the 409 itself still tells a scoped key the
        // key is taken somewhere; only a holder the key can see is named
        const who =
          visible === null || visible.includes(holder.productId)
            ? `issue ${holder.id} (externalRef ${holder.externalRef ?? "none"})`
            : "another issue";
        throw new ConflictError(
          `issue ${row.externalRef} sends sourceKey ${row.sourceKey}, but ${who} already has it: a source key names one issue, so send each issue its own Linear identifier`,
        );
      }
    }
    if (!current) {
      const inserted = tx
        .insert(issue)
        .values({
          productId: target.id,
          number: number as number,
          type: legacyTypeOf(target, actor.id),
          // a todo always has an assignee: the importing bot owns the product
          assigneeId:
            legacyTypeOf(target, actor.id) === "todo" ? actor.id : null,
          externalRef: row.externalRef,
          title: row.title,
          description: row.description ?? "",
          status: row.status,
          sourceStatus: row.sourceStatus,
          sourceKey: row.sourceKey ?? null,
          priority: row.priority ?? 0,
          estimate: row.estimate ?? null,
          sourceAuthor: row.sourceAuthor ?? null,
          createdAt: row.createdAt,
          completedAt,
          createdBy: actor.id,
        })
        .returning()
        .get();
      setLabels(tx, inserted, labelsOf(row.labels ?? []));
      setLinks(tx, inserted.id, row.links ?? []);
      tally.created.issues++;
      tally.created.links += row.links?.length ?? 0;
      return inserted.id;
    }

    const changed = changedFields<IssueRow>(current, {
      title: row.title,
      description: row.description,
      status: row.status,
      sourceStatus: row.sourceStatus,
      sourceKey: row.sourceKey,
      priority: row.priority,
      estimate: row.estimate,
      sourceAuthor: row.sourceAuthor,
      createdAt: row.createdAt,
      completedAt,
    });
    const nextLabels =
      row.labels === undefined ? undefined : labelsOf(row.labels);
    const labelsChanged =
      nextLabels !== undefined &&
      !sameJson(current.labels, sortedNames(nextLabels));
    const linksChanged =
      row.links !== undefined && !sameJson(current.links, row.links);
    for (const link of row.links ?? []) {
      const before = current.links.find((l) => l.url === link.url);
      const outcome = !before
        ? "created"
        : before.title === link.title
          ? "unchanged"
          : "updated";
      tally[outcome].links++;
    }
    if (isEmpty(changed) && !labelsChanged && !linksChanged) {
      tally.unchanged.issues++;
      return current.id;
    }
    tx.update(issue)
      .set({ ...changed, updatedAt: now })
      .where(eq(issue.id, current.id))
      .run();
    if (nextLabels && labelsChanged) setLabels(tx, current, nextLabels);
    if (row.links && linksChanged) setLinks(tx, current.id, row.links);
    tally.updated.issues++;
    return current.id;
  }

  function importComments(
    tx: Tx,
    actor: ActingActor,
    issueId: string,
    rows: NormalComment[],
    tally: Tally,
  ): void {
    if (rows.length === 0) return;
    const existing = new Map(
      tx
        .select()
        .from(comment)
        .where(
          and(eq(comment.issueId, issueId), isNotNull(comment.externalRef)),
        )
        .all()
        .map((c) => [c.externalRef, c]),
    );
    for (const row of rows) {
      const current = existing.get(row.externalRef);
      if (!current) {
        tx.insert(comment)
          .values({
            issueId,
            externalRef: row.externalRef,
            body: row.body,
            sourceAuthor: row.sourceAuthor ?? null,
            createdAt: row.createdAt,
            authorId: actor.id,
          })
          .run();
        tally.created.comments++;
        continue;
      }
      const changed = changedFields(current, {
        body: row.body,
        sourceAuthor: row.sourceAuthor,
        createdAt: row.createdAt,
      });
      if (isEmpty(changed)) {
        tally.unchanged.comments++;
        continue;
      }
      tx.update(comment).set(changed).where(eq(comment.id, current.id)).run();
      tally.updated.comments++;
    }
  }

  function importStatusUpdates(
    tx: Tx,
    actor: ActingActor,
    projectId: string,
    rows: NormalImport["statusUpdates"],
    tally: Tally,
  ): void {
    const existing = new Map(
      tx
        .select()
        .from(productStatusUpdate)
        .where(
          and(
            eq(productStatusUpdate.productId, projectId),
            isNotNull(productStatusUpdate.externalRef),
          ),
        )
        .all()
        .map((u) => [u.externalRef, u]),
    );
    for (const row of rows) {
      const current = existing.get(row.externalRef);
      if (!current) {
        tx.insert(productStatusUpdate)
          .values({
            productId: projectId,
            externalRef: row.externalRef,
            body: row.body,
            health: row.health,
            sourceAuthor: row.sourceAuthor ?? null,
            createdAt: row.createdAt,
            authorId: actor.id,
          })
          .run();
        tally.created.statusUpdates++;
        continue;
      }
      const changed = changedFields(current, {
        body: row.body,
        health: row.health,
        sourceAuthor: row.sourceAuthor,
        createdAt: row.createdAt,
      });
      if (isEmpty(changed)) {
        tally.unchanged.statusUpdates++;
        continue;
      }
      tx.update(productStatusUpdate)
        .set(changed)
        .where(eq(productStatusUpdate.id, current.id))
        .run();
      tally.updated.statusUpdates++;
    }
  }

  const sortedNames = (labels: Label[]) =>
    labels.map((l) => l.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  /** The item's create event, with the type and product an item event carries. */
  function itemCreated(tx: Tx, actor: ActingActor, created: Issue): NewEvent {
    const about =
      created.type === "note"
        ? aboutInEvents(tx, created.id, created.productId)
        : undefined;
    return {
      actorId: actor.id,
      subjectType: "issue",
      subjectId: created.id,
      productId: created.productId,
      action: "issue.created",
      payload: {
        key: created.key,
        type: created.type,
        product: created.productKey,
        title: created.title,
        description: created.description,
        status: created.status,
        assigneeId: created.assigneeId,
        estimate: created.estimate,
        priority: created.priority,
        labels: created.labels,
        links: created.links,
        externalRef: created.externalRef,
        ...(about && { about: about.keys, aboutOthers: about.others }),
      },
    };
  }

  /** An item as issue.create stored it before migration 0015: projectId (now its product's id, the same row) and no type. */
  type LegacyStoredItem = Omit<Issue, "productId" | "productKey" | "type"> & {
    projectId: string;
  };

  /** A created or updated item, with the label names a bot outside its product sent that the product has no label for. */
  type WrittenItem = Issue & { skippedLabels?: string[] };

  /**
   * A create's product and project as the call named them, and `place`, which
   * settles both for the write. A replay passes `settled`, the product its
   * stored item is on, for the product the call left out, so no default read
   * from current data refuses it.
   */
  type Placement = {
    product?: Product;
    project?: ProjectRow;
    place: (settled?: Product) => { product: Product; project?: ProjectRow };
  };

  const storedProductId = (item: WrittenItem | LegacyStoredItem) =>
    "productId" in item ? item.productId : item.projectId;

  /**
   * The product's labels by these names; an `outsider` attaches only those the
   * product has, the rest are `skipped`, while anyone else creates the missing.
   */
  function labelsFor(
    tx: Tx,
    productId: string,
    names: string[],
    outsider: boolean,
  ): { labels: Label[]; skipped: string[] } {
    if (!outsider) {
      return { labels: labelsNamed(tx, productId, names), skipped: [] };
    }
    const found = names.map((name) => findLabel(tx, productId, name));
    return {
      labels: found.filter((l) => l !== undefined),
      skipped: names.filter((_, i) => found[i] === undefined),
    };
  }

  const withSkipped = (item: Issue, skipped: string[]): WrittenItem =>
    skipped.length === 0 ? item : { ...item, skippedLabels: skipped };

  /**
   * A created item as `actor` sees it now: its projects, and a note's about,
   * are those the caller reaches, since a replay may come from another key of
   * the bot or after a scope edit; a stored replay from before items carried
   * their product key and projects is brought to today's shape.
   */
  function currentShape(
    item: WrittenItem | LegacyStoredItem,
    actor: ActingActor,
  ): WrittenItem {
    if ("productKey" in item) {
      const projects = projectsSeenBy(db, [item.id], actor).map(
        ({ slug, name }) => ({ slug, name }),
      );
      if (item.type !== "note") return { ...item, projects };
      const about = aboutOf(db, [item.id], actor).get(item.id) ?? [];
      return { ...item, projects, about };
    }
    const { projectId, ...stored } = item;
    // the stored item has no type: the one migration 0015 gave the row
    const { type } = db
      .select({ type: issue.type })
      .from(issue)
      .where(eq(issue.id, item.id))
      .get() as { type: IssueType };
    return hydrateOne(db, { ...stored, productId: projectId, type }, actor);
  }

  /**
   * Creates an item: an issue starts in triage, a todo open and always
   * assigned, a note current and never assigned. `input.product` names the
   * product, else `fallback` picks it; `typeOf` decides the type once the
   * product is known, and `asked` is the type the caller asked for by the
   * call it made (none for the legacy create). `assignee` left out assigns a
   * todo to the product's owner, else the caller. An idempotency key is checked
   * against the input as sent, so what `fallback`, `typeOf` and the default
   * assignee read from current data can't turn a retry into a mismatch.
   * `placement`, when given, replaces how the product is named and picked, and
   * may put the item in a project.
   */
  function createItem(
    actor: ActingActor,
    input: ItemInput,
    options: WriteOptions,
    {
      asked,
      fallback,
      typeOf,
      placement,
    }: {
      asked: IssueType | undefined;
      fallback?: (tx: Tx) => Product;
      typeOf: (target: Product) => IssueType;
      placement?: (tx: Tx) => Placement;
    },
  ): WrittenItem {
    if (actor.kind === "human" && input.assignee != null) {
      throw new ForbiddenError(
        "a person files an issue unassigned: drop the assignee, and the product's bot assigns it",
      );
    }
    // before the assignee is resolved, so an unknown name isn't refused for the name first
    if (asked === "note" && input.assignee != null) {
      throw new ValidationError(
        "a note has no assignee, since nobody has to act on it: leave assignee out, and file an issue (file_issue) for work someone has to do, listing it in the note's about",
      );
    }
    const title = nonBlank(input.title, "title");
    const priority = validPriority(input.priority);
    const estimate = validEstimate(input.estimate);
    const labelNames = validLabelNames(input.labels ?? []);
    const links = validLinks(input.links ?? []);
    const externalRef = optionalRef(input.externalRef);
    const about =
      input.about === undefined ? undefined : validAbout(input.about, "about");
    const created = currentShape(
      create(actor, options, "issue.create", (tx) => {
        const placed = placement?.(tx) ?? productPlacement(tx);
        const named = placed.product;
        const assignee =
          input.assignee == null
            ? input.assignee
            : resolveAssignee(tx, input.assignee);
        const sent = {
          title,
          description: input.description ?? "",
          estimate: estimate ?? null,
          priority: priority ?? 0,
          externalRef,
        };
        // who may put an item where: run by the write and by a replay
        const authorize = (settled?: Product) => {
          const { product, project } = placed.place(settled);
          const type = typeOf(product);
          if (type === "todo" && actor.kind === "human") {
            throw new ForbiddenError(
              "a person files issues, not todos: file it as an issue, and the product's bot accepts it from triage",
            );
          }
          if (about !== undefined && type !== "note") {
            throw new ValidationError(
              "about is a note's field, the items it is about: leave it out of a todo or an issue, and add a note about the item with add_note",
            );
          }
          if (
            type === "note" &&
            (input.priority !== undefined || input.estimate !== undefined)
          ) {
            throw new ValidationError(
              "a note has no priority or estimate, since nobody has to act on it: leave both out, and file an issue (file_issue) for work someone has to do, listing it in the note's about",
            );
          }
          if (type === "todo") {
            requireOwner(
              tx,
              actor,
              product.id,
              (owner, key) =>
                `${key} is owned by ${owner}, so only ${owner} adds its todos: file the work as an issue with file_issue (POST /items with type issue), and ${owner} accepts it from triage`,
            );
          }
          return { product, project, type };
        };
        return {
          request: {
            type: asked,
            productId: named?.id,
            projectId: placed.project?.id,
            assigneeId: assignee,
            ...sent,
            labels: labelNames,
            links,
            about,
          },
          // as issue.create hashed it before migration 0015, when every create named its product and none a project
          legacyRequest: named &&
            placed.project === undefined && {
              projectId: named.id,
              ...sent,
              assigneeId: assignee ?? null,
              labels: labelNames,
              links,
            },
          replay: (stored: WrittenItem | LegacyStoredItem) => {
            authorize(findProduct(tx, storedProductId(stored), undefined));
            resolveIssueRow(tx, stored.id, actor);
          },
          write: () => {
            const { product, project: into, type } = authorize();
            if (type === "todo" && assignee === null) {
              throw new ValidationError(
                "a todo always has an assignee: leave assignee out to assign it to the product's owner, or name a bot",
              );
            }
            const assigneeId =
              assignee ??
              (type === "todo" ? (product.ownerId ?? actor.id) : null);
            const aboutIds =
              type === "note"
                ? aboutRows(tx, actor, about ?? [], "about").map((r) => r.id)
                : [];
            if (externalRef !== null) {
              const twin = tx
                .select({ id: issue.id, number: issue.number })
                .from(issue)
                .where(
                  and(
                    eq(issue.productId, product.id),
                    eq(issue.externalRef, externalRef),
                  ),
                )
                .get();
              if (twin) {
                throw new ConflictError(
                  `externalRef ${externalRef} is already on item ${product.key}-${twin.number}: update that item with update_item, or send a different externalRef`,
                );
              }
            }
            const row = tx
              .insert(issue)
              .values({
                ...sent,
                productId: product.id,
                type,
                assigneeId,
                status: startStatus[type],
                number: nextIssueNumber(tx, product.id),
                createdBy: actor.id,
              })
              .returning()
              .get();
            // a filer outside the product attaches the owner's labels, never adds its own to the set
            const { labels, skipped } = labelsFor(
              tx,
              product.id,
              labelNames,
              type !== "todo" &&
                product.ownerId !== null &&
                product.ownerId !== actor.id,
            );
            setLabels(tx, row, labels);
            setLinks(tx, row.id, links);
            if (type === "note") setAbout(tx, row.id, aboutIds);
            if (into !== undefined) {
              tx.insert(projectItem)
                .values({
                  projectId: into.id,
                  issueId: row.id,
                  productId: product.id,
                  addedBy: actor.id,
                })
                .run();
              touchProject(tx, into.id);
            }
            const created = hydrateOne(tx, row, actor);
            return {
              result: withSkipped(created, skipped),
              event:
                into === undefined
                  ? itemCreated(tx, actor, created)
                  : [
                      itemCreated(tx, actor, created),
                      membership(
                        actor,
                        into,
                        row,
                        "project.item_added",
                        created.key,
                      ),
                    ],
            };
          },
        };
      }),
      actor,
    );
    return withPullRequest(created);

    /** The product `input.product` names among the actor's product grant, else the one `fallback` picks; no project. */
    function productPlacement(tx: Tx): Placement {
      const named =
        input.product === undefined
          ? undefined
          : resolveProduct(tx, input.product, actor);
      return {
        product: named,
        place: (settled) => ({
          product: named ?? settled ?? (fallback as (tx: Tx) => Product)(tx),
        }),
      };
    }
  }

  /**
   * Where file_issue puts an issue: `product` and `project` as sent, resolved
   * among what the actor may name and reaches, and checked against an
   * idempotency key; `place` reads current data for what was left out.
   */
  function issuePlacement(
    tx: Tx,
    actor: ActingActor,
    ref: string | undefined,
    slug: string | undefined,
    tool = "file_issue",
    item: "issue" | "note" = "issue",
  ): Placement {
    const named =
      ref === undefined ? undefined : resolveNamedProduct(tx, ref, actor);
    if (named !== undefined) requireFilingGrant(tx, actor, named, item);
    const into =
      slug === undefined ? undefined : resolveProject(tx, slug, actor);
    return {
      product: named,
      project: into,
      place: (settled) => {
        if (into !== undefined) {
          return {
            product: drawnProduct(
              tx,
              actor,
              into,
              named ?? settled,
              tool,
              item,
            ),
            project: into,
          };
        }
        const product = named as Product;
        if (grantsProduct(actor, product.id)) return { product };
        return { product, project: onlyProject(tx, actor, product, tool) };
      },
    };
  }

  /**
   * The product of `into` the item goes to: `named` when the project draws
   * from it, else the project's one product. Of `into`'s products the actor
   * files on those its product grant covers, or on all of them when `into` is
   * one of its own projects, so the item stays one it reaches; a refusal names
   * those and only counts the rest.
   */
  function drawnProduct(
    tx: Tx,
    actor: ActingActor,
    into: ProjectRow,
    named: Product | undefined,
    tool: string,
    item: "issue" | "note",
  ): Product {
    const drawn = tx
      .select(getTableColumns(product))
      .from(product)
      .innerJoin(projectProduct, eq(projectProduct.productId, product.id))
      .where(eq(projectProduct.projectId, into.id))
      .orderBy(product.key)
      .all();
    const ownProject = projectIdsOf(actor)?.includes(into.id) ?? true;
    const fileable = ownProject
      ? drawn
      : drawn.filter((p) => grantsProduct(actor, p.id));
    const keys = fileable.map((p) => p.key);
    const others = drawn.length - fileable.length;
    const drawsFrom = andList(
      others === 0
        ? keys
        : [...keys, `${others} other product${others === 1 ? "" : "s"}`],
    );
    const sendOne = keys.length === 1 ? keys[0] : `one of ${andList(keys)}`;
    if (named !== undefined) {
      if (fileable.some((p) => p.id === named.id)) return named;
      if (drawn.some((p) => p.id === named.id)) {
        const slugs = projectsDrawingFrom(tx, actor, named.id).map(
          (p) => p.slug,
        );
        throw new ValidationError(
          `this key files on product ${named.key} only through ${projectList(slugs)}, not project ${into.slug}: send ${projectArgs(slugs)} with product ${named.key}, or send product with ${sendOne} and project ${into.slug}`,
        );
      }
      throw new ValidationError(
        drawn.length === 0
          ? `project ${into.slug} draws from no product yet, so nothing is filed into it: ${item === "note" ? "add the note" : "file the issue"} on ${named.key} without project, then add it with add_to_project (POST /projects/{slug}/items)`
          : `project ${into.slug} draws from ${drawsFrom}, not ${named.key}: send product with ${sendOne}, or a project that draws from ${named.key} (list_projects shows each one's products)`,
      );
    }
    // a project the actor reaches but doesn't list draws from a product its grant covers
    if (drawn.length === 1) return fileable[0] as Product;
    throw new ValidationError(
      drawn.length === 0
        ? `project ${into.slug} draws from no product yet, so ${tool} needs product: send the key (like TRL) of the product the ${item} is for, without project, then add the ${item} with add_to_project (POST /projects/{slug}/items)`
        : `project ${into.slug} draws from ${drawsFrom}, so ${tool} needs product: send product with ${others === 0 ? "one of them" : sendOne}`,
    );
  }

  /** The key's one project, for an issue on a product it reaches only through projects; with several, a 422 listing them. */
  function onlyProject(
    tx: Tx,
    actor: ActingActor,
    named: Product,
    tool: string,
  ): ProjectRow {
    const via = projectsDrawingFrom(tx, actor, named.id);
    if (actor.scope?.projects.length === 1 && via.length === 1) {
      return via[0] as ProjectRow;
    }
    const slugs = via.map((p) => p.slug);
    throw new ValidationError(
      `this key reaches product ${named.key} only through ${projectList(slugs)}, so ${tool} needs project: resend with ${projectArgs(slugs)}`,
    );
  }

  /** "Exactly one of product and project" for a status update read or write. */
  function statusTargetOf(
    target: StatusTarget,
    doing: string,
  ): { product: string } | { project: string } {
    const product = target.product?.trim() || undefined;
    const projectSlug = target.project?.trim() || undefined;
    if ((product === undefined) === (projectSlug === undefined)) {
      throw new ValidationError(
        `${doing} takes exactly one of product (a key like TRL) and project (a slug like launch-q4): send ${product === undefined ? "one" : "only one"} of them`,
      );
    }
    return product === undefined
      ? { project: projectSlug as string }
      : { product: product };
  }

  /** Who may change a project: a bot whose key has the issues action and reaches one of its products. */
  function requireProjectWrite(
    actor: ActingActor,
    doing: string,
    slug: string,
    slugOnly?: string,
  ): void {
    requireBot(actor, doing);
    requireAction(actor, "issues", doing, () =>
      resolveProject(db, slug, actor, slugOnly),
    );
  }

  /** The product whose key is `slug` in upper case: refs match keys in any case, so a slug never may. */
  function productKeyedAs(tx: Tx, slug: string): Product | undefined {
    return tx
      .select()
      .from(product)
      .where(eq(product.key, slug.toUpperCase()))
      .get();
  }

  /** Refuses a new product's key that is a project's slug in another case. */
  function requireKeyNoSlug(tx: Tx, key: string): void {
    const clash = tx
      .select({ slug: project.slug })
      .from(project)
      .where(eq(project.slug, key.toLowerCase()))
      .get();
    if (clash) {
      throw new ConflictError(
        `product key ${key} is the slug of project ${clash.slug}, and a product's key never matches a project's slug: choose another key`,
      );
    }
  }

  /** `base`, or `base-2`, `base-3`, ... : the first slug no project holds and no product key matches. */
  function freeSlug(tx: Tx, base: string): string {
    const taken = (slug: string) =>
      tx
        .select({ id: project.id })
        .from(project)
        .where(eq(project.slug, slug))
        .get() !== undefined || productKeyedAs(tx, slug) !== undefined;
    if (!taken(base)) return base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const slug = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
      if (!taken(slug)) return slug;
    }
  }

  /** The item refs of an add or remove, checked for count before any lookup. */
  function validItemRefs(refs: string[], doing: string): string[] {
    if (refs.length === 0) {
      throw new ValidationError(
        `${doing} needs at least one item: send items as keys like TRL-12`,
      );
    }
    if (refs.length > PROJECT_ITEMS_MAX) {
      throw new ValidationError(
        `items names ${refs.length} items, over the limit of ${PROJECT_ITEMS_MAX}: send them in calls of ${PROJECT_ITEMS_MAX} or fewer`,
      );
    }
    return refs;
  }

  const membership = (
    actor: ActingActor,
    target: ProjectRow,
    row: IssueRow,
    action: "project.item_added" | "project.item_removed",
    key: string,
  ): NewEvent => ({
    actorId: actor.id,
    subjectType: "issue",
    subjectId: row.id,
    productId: row.productId,
    projectId: target.id,
    action,
    payload: { project: target.slug, key },
  });

  /** A project's edit time moves when its items change, so lists sort it as touched. */
  function touchProject(tx: Tx, projectId: string) {
    tx.update(project)
      .set({ updatedAt: new Date() })
      .where(eq(project.id, projectId))
      .run();
  }

  /** Product changes, owner by bot, as the product event payload carries them. */
  function productFields(
    tx: Tx | Db,
    input: { repoUrl?: string | null; owner?: string | null },
  ) {
    return {
      repoUrl: validRepoUrl(input.repoUrl),
      ownerId:
        input.owner == null
          ? input.owner
          : resolveBot(tx, input.owner, "owner").id,
    };
  }

  /** Inserts a product or team whose key and externalRef no row holds, with its product.created event. */
  function insertProduct(
    tx: Tx,
    actor: ActingActor,
    fields: Omit<
      typeof product.$inferInsert,
      "id" | "createdBy" | "createdAt" | "updatedAt" | "issueSeq"
    > & { key: string; kind: ProductKind },
  ): Write<Product> {
    const taken = tx
      .select()
      .from(product)
      .where(eq(product.key, fields.key))
      .get();
    if (taken) {
      throw new ConflictError(
        `product key ${fields.key} is taken by ${taken.kind} "${taken.name}": choose another key`,
      );
    }
    requireKeyNoSlug(tx, fields.key);
    if (fields.externalRef != null) {
      const twin = tx
        .select()
        .from(product)
        .where(eq(product.externalRef, fields.externalRef))
        .get();
      if (twin) {
        throw new ConflictError(
          `externalRef ${fields.externalRef} is already on product ${twin.key}: use that product, or send a different externalRef`,
        );
      }
    }
    const created = tx
      .insert(product)
      .values({ ...fields, createdBy: actor.id })
      .returning()
      .get();
    return {
      result: created,
      event: {
        actorId: actor.id,
        subjectType: "product",
        subjectId: created.id,
        productId: created.id,
        action: "product.created",
        payload: {
          name: created.name,
          key: created.key,
          kind: created.kind,
          description: created.description,
          externalRef: created.externalRef,
          repoUrl: created.repoUrl,
          ownerId: created.ownerId,
        },
      },
    };
  }

  /**
   * The products and teams the bot owns, whatever its key reaches, A to Z by
   * key: who may create a team is decided on these.
   */
  function everythingOwnedBy(tx: Tx | Db, actorId: string): Product[] {
    return tx
      .select()
      .from(product)
      .where(eq(product.ownerId, actorId))
      .orderBy(asc(product.key))
      .all();
  }

  /**
   * Refuses a team to a bot that owns a product or a team already, naming where
   * its work goes instead: by key only what the calling key reaches, since a
   * write it can't make there is no next step.
   */
  function requireOwnsNothing(tx: Tx, actor: ActingActor): void {
    const owned = everythingOwnedBy(tx, actor.id);
    if (owned.length === 0) return;
    const admin =
      "an admin creates more products or teams with create_product (POST /products)";
    const products = owned.filter((p) => p.kind === "product");
    if (products.length > 0) {
      const reached = products.filter((p) => grantsProduct(actor, p.id));
      const keys = andList(reached.map((p) => p.key));
      throw new ConflictError(
        reached.length === 0
          ? `you own a product this key doesn't reach, and a team is only for a bot that owns no product or team: ask whoever minted the key to add your product to it and keep your own work there, or ask an admin, who creates more products or teams with create_product (POST /products)`
          : `you own product${plural(reached.length)} ${keys}, and a team is only for a bot that owns no product or team: keep your own work in ${reached.length > 1 ? "one of them" : keys} (add_todo, add_note with product ${reached[0]?.key}); ${admin}`,
      );
    }
    const team = owned.find((p) => grantsProduct(actor, p.id));
    throw new ConflictError(
      team === undefined
        ? `you already own a team this key doesn't reach, and a bot creates at most one team itself: ask whoever minted the key to add your team to it, or ask an admin, who creates more products or teams with create_product (POST /products)`
        : `you already own team ${team.key}, and a bot creates at most one team itself: keep your own work there (add_todo, add_note with product ${team.key}); ${admin}`,
    );
  }

  /**
   * Refuses a team's key that a product holds or that is a project's slug, in
   * words that tell neither apart: create_team's caller may see neither.
   */
  function requireKeyAvailable(tx: Tx, key: string): void {
    const held =
      productKeyedAs(tx, key) !== undefined ||
      tx
        .select({ id: project.id })
        .from(project)
        .where(eq(project.slug, key.toLowerCase()))
        .get() !== undefined;
    if (held) {
      throw new ConflictError("that key is not available: choose another key");
    }
  }

  /** Adds `productId` to every live key of the bot whose product list is limited, so those keys reach it at once. */
  function extendLimitedKeys(tx: Tx, actorId: string, productId: string) {
    const limited = tx
      .selectDistinct({ id: apiKeyProduct.apiKeyId })
      .from(apiKeyProduct)
      .innerJoin(apiKey, eq(apiKey.id, apiKeyProduct.apiKeyId))
      .where(and(eq(apiKey.actorId, actorId), isNull(apiKey.revokedAt)))
      .all();
    if (limited.length === 0) return;
    // a key that lists the product already keeps its row
    tx.insert(apiKeyProduct)
      .values(limited.map((k) => ({ apiKeyId: k.id, productId })))
      .onConflictDoNothing()
      .run();
  }

  return {
    /** A bot with the admin action and an unrestricted key creates a product; it owns it unless `owner` names another bot. */
    createProduct(
      actor: ActingActor,
      input: ProductInput,
      options: WriteOptions = {},
    ): ProductView {
      requireBot(actor, "create a product");
      requireAction(actor, "admin", "create a product");
      const scope = actor.scope;
      // before the key is checked, so a taken key in a hidden product tells it nothing
      if (scope?.products) {
        throw new ForbiddenScopeError(
          `this key may not create a product: it reaches only ${reachOf(scope)}. Ask whoever minted the key for ${unlimitedKey(scope)}.`,
        );
      }
      const fields = {
        name: nonBlank(input.name, "name"),
        key: validProductKey(input.key),
        description: input.description ?? "",
        externalRef: optionalRef(input.externalRef),
        repoUrl: validRepoUrl(input.repoUrl) ?? null,
      };
      const kind = input.kind ?? "product";
      // the stored scope keeps the name it had before products and projects split
      const row = create(actor, options, "project.create", (tx) => {
        const owner =
          input.owner === undefined
            ? undefined
            : (productFields(tx, { owner: input.owner }).ownerId ?? null);
        const ownerId = owner === undefined ? actor.id : owner;
        return {
          // kind only when a team, so a retry of a create stored before kind still matches
          request: {
            ...fields,
            ownerId: owner,
            ...(kind === "team" && { kind }),
          },
          // as project.create hashed it before migration 0015, which had no repoUrl or owner to send
          legacyRequest:
            owner === undefined && fields.repoUrl === null && kind === "product"
              ? {
                  name: fields.name,
                  key: fields.key,
                  description: fields.description,
                  externalRef: fields.externalRef,
                }
              : undefined,
          write: () => {
            const written = insertProduct(tx, actor, {
              ...fields,
              kind,
              ownerId,
            });
            // a team's owner works in it at once, as after create_team
            if (kind === "team" && ownerId !== null) {
              extendLimitedKeys(tx, ownerId, written.result.id);
            }
            return written;
          },
        };
      });
      // a replay stored before migration 0015 lacks the owner and repoUrl columns, and one before 0022
      // lacks kind: read them from the row
      const stored: Partial<Product> & Pick<Product, "id"> = row;
      return productView(
        db,
        "ownerId" in stored && "kind" in stored
          ? row
          : (db.select().from(product).where(eq(product.id, row.id)).get() ??
              row),
      );
    },

    /**
     * A bot that owns no product and no team creates its one team, owned by
     * itself, with the issues action and a key with a product list or no
     * product limit.
     */
    createTeam(
      actor: ActingActor,
      input: TeamInput,
      options: WriteOptions = {},
    ): ProductView {
      requireBot(actor, "create a team");
      requireAction(actor, "issues", "create a team");
      // only keys with a product list are widened to the new team; one limited to projects would 404 on it
      const scope = actor.scope;
      if (scope?.products?.length === 0) {
        throw new ForbiddenScopeError(
          `this key may not create a team: it reaches only ${reachOf(scope)}, so it could not work in a team. Ask whoever minted the key for one with a product list, or with no product limit, and create the team with that.`,
        );
      }
      const fields = {
        name: nonBlank(input.name, "name"),
        key: validProductKey(input.key),
        description: input.description ?? "",
      };
      const row = create(actor, options, "team.create", (tx) => ({
        request: fields,
        // in write, not before it: a replay of the create finds the team it made
        write: () => {
          requireOwnsNothing(tx, actor);
          requireKeyAvailable(tx, fields.key);
          const written = insertProduct(tx, actor, {
            ...fields,
            kind: "team",
            ownerId: actor.id,
          });
          extendLimitedKeys(tx, actor.id, written.result.id);
          return written;
        },
      }));
      return productView(db, row);
    },

    /**
     * A patch that changes nothing writes nothing and emits no event. A
     * product's owner changes only when it has none or the caller is it.
     */
    updateProduct(
      actor: ActingActor,
      ref: string,
      patch: ProductPatch,
    ): ProductView {
      requireBot(actor, "update a product");
      requireAction(actor, "admin", "update a product", () =>
        resolveProduct(db, ref, actor),
      );
      const name =
        patch.name === undefined ? undefined : nonBlank(patch.name, "name");
      return commit((tx) => {
        const current = resolveProduct(tx, ref, actor);
        const next = {
          name,
          description: patch.description,
          kind: patch.kind,
          ...productFields(tx, patch),
        };
        // the CLI's products set-owner (service/product-admin.ts) reassigns without this check
        if (next.ownerId !== undefined && next.ownerId !== current.ownerId) {
          requireOwner(
            tx,
            actor,
            current.id,
            (owner, key) =>
              `${key} is owned by ${owner}: only ${owner} may hand it to another bot or clear its owner over the API. The operator reassigns it with \`trail products set-owner ${key} <bot>\``,
          );
        }
        const changes = changesOf(current, next);
        if (isEmpty(changes)) {
          return { result: productView(tx, current), event: null };
        }
        const updated = tx
          .update(product)
          .set(next)
          .where(eq(product.id, current.id))
          .returning()
          .get() as Product;
        if (
          updated.kind === "team" &&
          updated.ownerId !== null &&
          ("kind" in changes || "ownerId" in changes)
        ) {
          extendLimitedKeys(tx, updated.ownerId, updated.id);
        }
        return {
          result: productView(tx, updated),
          event: {
            actorId: actor.id,
            subjectType: "product",
            subjectId: current.id,
            productId: current.id,
            action: "product.updated",
            payload: changes,
          },
        };
      });
    },

    /** A product the actor may name: one its products or projects reach; whole, with its notes per status. */
    getProduct(actor: ActingActor, ref: string): ProductDetail | NamedProduct {
      requireAction(actor, "read", "read a product", () =>
        resolveNamedProduct(db, ref, actor),
      );
      const read = productReads(actor, [
        resolveNamedProduct(db, ref, actor),
      ])[0] as ProductView | NamedProduct;
      if (!("createdBy" in read)) return read;
      const notes = noNotes();
      for (const { status, n } of db
        .select({ status: issue.status, n: sql<number>`count(*)` })
        .from(issue)
        // by status, not type: issue_note_status_check makes them the same rows, and status is in
        // issue_product_status_created_idx, so the count reads the index alone
        .where(
          and(
            eq(issue.productId, read.id),
            inArray(issue.status, [...noteStatuses]),
          ),
        )
        .groupBy(issue.status)
        .all()) {
        if (isNoteStatus(status)) notes[status] = n;
      }
      return { ...read, notes };
    },

    /** Newest first; the products the actor may name, with those its projects draw from; with `kind`, only those of that kind it reads whole. */
    listProducts(
      actor: ActingActor,
      query: PageQuery & { kind?: ProductKind } = {},
    ): Page<ProductView | NamedProduct> {
      requireAction(actor, "read", "list products");
      const visible = [productsNamed(db, reachFor(actor), product.id)];
      // a product named only through a project hides its kind, so a filter on kind leaves it out
      if (query.kind !== undefined) {
        visible.push(
          eq(product.kind, query.kind),
          amongProducts(product.id, productIdsOf(actor)),
        );
      }
      const found = page(
        product,
        "desc",
        query,
        visible,
        (where, orderBy, limit) =>
          db
            .select()
            .from(product)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
      return { ...found, items: productReads(actor, found.items) };
    },

    /**
     * Adds a todo: planned work, open from the start and always assigned. With
     * no `product`, the caller's own product when it owns exactly one. In a
     * product with an owner, only the owner may.
     */
    addTodo(
      actor: ActingActor,
      input: ItemInput,
      options: WriteOptions = {},
    ): WrittenItem {
      if (input.project !== undefined) {
        throw new ValidationError(
          "add_todo takes no project: add the todo without it, then add it to the project with add_to_project (POST /projects/{slug}/items); file_issue (POST /items) is what takes project",
        );
      }
      requireAction(actor, "issues", "add a todo", () =>
        input.product === undefined
          ? undefined
          : resolveProduct(db, input.product, actor),
      );
      return createItem(actor, input, options, {
        asked: "todo",
        fallback: (tx) => defaultProduct(tx, actor, "add_todo"),
        typeOf: () => "todo",
      });
    },

    /**
     * Files an issue on a product the caller may name; it waits in triage
     * until the product's bot accepts or cancels it. With `project` it joins
     * that project in the same write, and the product must be one the project
     * draws from (left out, the project's one product). A key reaching the
     * product only through projects files with `project`, which defaults to
     * the key's one project when it names exactly one.
     */
    fileIssue(
      actor: ActingActor,
      input: ItemInput,
      options: WriteOptions = {},
    ): WrittenItem {
      const ref = input.product?.trim() || undefined;
      const slug = input.project?.trim() || undefined;
      if (ref === undefined && slug === undefined) {
        throw new ValidationError(
          "file_issue needs product: the key (like TRL) of the product the issue is for, or project: the slug (like launch-q4) of a project drawing from one product; list_products and list_projects list them",
        );
      }
      requireAction(actor, "issues", "file an issue", () =>
        slug === undefined
          ? resolveNamedProduct(db, ref as string, actor)
          : resolveProject(db, slug, actor),
      );
      return createItem(actor, input, options, {
        asked: "issue",
        typeOf: () => "issue",
        placement: (tx) => issuePlacement(tx, actor, ref, slug),
      });
    },

    /**
     * Adds a note: a record nobody has to act on, on any product the caller
     * may file an issue on, current from the start and never assigned. With
     * `project` it joins that project as `fileIssue` puts an issue there.
     */
    addNote(
      actor: ActingActor,
      input: ItemInput,
      options: WriteOptions = {},
    ): WrittenItem {
      requireBot(actor, "add a note");
      const ref = input.product?.trim() || undefined;
      const slug = input.project?.trim() || undefined;
      if (ref === undefined && slug === undefined) {
        throw new ValidationError(
          "add_note needs product: the key (like TRL) of the product the note belongs to, or project: the slug (like launch-q4) of a project drawing from one product; list_products and list_projects list them",
        );
      }
      requireAction(actor, "issues", "add a note", () =>
        slug === undefined
          ? resolveNamedProduct(db, ref as string, actor)
          : resolveProject(db, slug, actor),
      );
      return createItem(
        actor,
        { ...input, about: input.about ?? [] },
        options,
        {
          asked: "note",
          typeOf: () => "note",
          placement: (tx) =>
            issuePlacement(tx, actor, ref, slug, "add_note", "note"),
        },
      );
    },

    /** The legacy create: a todo when the caller owns the product, else an issue in triage. */
    createIssue(
      actor: ActingActor,
      input: IssueInput,
      options: WriteOptions = {},
    ): WrittenItem {
      const { projectId, project, product, assigneeId, ...rest } = input;
      const ref = legacyProduct({ projectId, project, product });
      if (ref === undefined) {
        throw new ValidationError(
          "projectId is required: send the product's key, like TRL (project or product are its aliases); list_products lists them",
        );
      }
      requireAction(actor, "issues", "create an issue", () =>
        resolveProduct(db, ref, actor),
      );
      return createItem(
        actor,
        { ...rest, product: ref, assignee: assigneeId ?? undefined },
        options,
        {
          asked: undefined,
          typeOf: (target) => legacyTypeOf(target, actor.id),
        },
      );
    },

    /**
     * A patch that changes nothing writes nothing and emits no event. Setting
     * type todo on an item in triage opens it; a todo is never in triage and
     * never unassigned. On a product with an owner, only the owner moves an
     * item out of triage or changes its type, and only the owner or its filer
     * cancels it. `legacy` words the refusals for update_issue and PATCH
     * /issues, which have no type field.
     */
    updateItem(
      actor: ActingActor,
      ref: string,
      patch: IssuePatch,
      { legacy = false }: { legacy?: boolean } = {},
    ): WrittenItem {
      requireBot(actor, "update an item");
      // the legacy routes predate notes, and find none
      const findRow = (tx: Tx | Db) =>
        legacy ? workRow(tx, ref, actor) : resolveIssueRow(tx, ref, actor);
      requireAction(actor, "issues", "update an item", () => findRow(db));
      requireItemWrite(db, actor, findRow(db), "update an item");
      const next = {
        title:
          patch.title === undefined
            ? undefined
            : nonBlank(patch.title, "title"),
        description: patch.description,
        estimate: validEstimate(patch.estimate),
        priority: validPriority(patch.priority),
      };
      const status =
        patch.status === undefined ? undefined : validStatus(patch.status);
      if (
        patch.labels !== undefined &&
        (patch.addLabels !== undefined || patch.removeLabels !== undefined)
      ) {
        throw new ValidationError(
          "labels replaces the whole set, so it cannot go with addLabels or removeLabels: send labels alone to replace the set, or addLabels and removeLabels to change part of it",
        );
      }
      if (
        patch.links !== undefined &&
        (patch.addLinks !== undefined || patch.removeLinks !== undefined)
      ) {
        throw new ValidationError(
          "links replaces the whole set, so it cannot go with addLinks or removeLinks: send links alone to replace the set, or addLinks and removeLinks to change part of it",
        );
      }
      const addLabels =
        patch.addLabels === undefined
          ? undefined
          : validLabelNames(patch.addLabels);
      const removeKeys = new Set(
        validLabelNames(patch.removeLabels ?? []).map(labelKey),
      );
      const addLinks =
        patch.addLinks === undefined ? undefined : validLinks(patch.addLinks);
      // a title the bot left out must not overwrite the one a link already has
      const untitled = new Set(
        (patch.addLinks ?? [])
          .filter((l) => (l.title ?? "").trim() === "")
          .map((l) => l.url.trim()),
      );
      const removeUrls = new Set(
        (patch.removeLinks ?? []).map((u) => nonBlank(u, "link url")),
      );
      if (
        patch.about !== undefined &&
        (patch.addAbout !== undefined || patch.removeAbout !== undefined)
      ) {
        throw new ValidationError(
          "about replaces the whole set, so it cannot go with addAbout or removeAbout: send about alone to replace the set, or addAbout and removeAbout to change part of it",
        );
      }
      const aboutSent =
        patch.about === undefined
          ? undefined
          : validAbout(patch.about, "about");
      const addAbout =
        patch.addAbout === undefined
          ? undefined
          : validAbout(patch.addAbout, "addAbout");
      const removeAbout =
        patch.removeAbout === undefined
          ? undefined
          : validAbout(patch.removeAbout, "removeAbout");
      const labelNames =
        patch.labels === undefined ? undefined : validLabelNames(patch.labels);
      const replacementLinks =
        patch.links === undefined ? undefined : validLinks(patch.links);
      const updated = commit((tx) => {
        const row = findRow(tx);
        requireItemWrite(tx, actor, row, "update an item");
        const current = hydrateOne(tx, row, actor);
        const type = patch.type ?? row.type;
        if (row.type === "note") requireNoteEdit(tx, actor, row, current.key);
        if (type === "todo" && status === "triage") {
          throw new ValidationError(
            `${current.key} is a todo, and a todo is never in triage: send type issue with status triage in the same update to put it in triage as an issue, or another status to keep it a todo`,
          );
        }
        // a note refuses any assignee below, so the name is never resolved first to be refused as unknown
        let assigneeId =
          patch.assigneeId === undefined
            ? row.assigneeId
            : patch.assigneeId === null || type === "note"
              ? null
              : resolveAssignee(tx, patch.assigneeId);
        if (type === "todo" && assigneeId === null) {
          if (patch.assigneeId === null) {
            throw new ValidationError(
              legacy
                ? `${current.key} is a todo, and a todo always has an assignee, so it can't be unassigned: reassign it by sending assigneeId with another bot's name or id (list_bots lists them)`
                : `${current.key} is a todo, and a todo always has an assignee: assign it to another bot, or send type issue to make it an unassigned issue`,
            );
          }
          assigneeId = ownerIdOf(tx, row.productId) ?? actor.id;
        }
        const nextStatus =
          status ??
          (type === "note"
            ? row.type === "note"
              ? row.status
              : "current"
            : row.type === "note"
              ? startStatus[type]
              : type === "todo" && row.status === "triage"
                ? "open"
                : row.status);
        if (type !== row.type) {
          const retyping =
            type === "note"
              ? "turns an item into a note"
              : row.type === "note"
                ? "turns a note into work"
                : "changes an item's type between todo and issue";
          // requireOwner passes anyone on a product with no owner, but only a product's own bot retypes to or from a note, so there no bot does
          if (
            (type === "note" || row.type === "note") &&
            ownerIdOf(tx, row.productId) === null
          ) {
            const productKey = current.key.slice(
              0,
              current.key.lastIndexOf("-"),
            );
            const instead =
              type === "note"
                ? `add a note about ${current.key} with add_note`
                : "file an issue (file_issue) for the work";
            throw new ForbiddenError(
              `${productKey} has no owner bot, and only a product's own bot ${retyping}: ${instead} instead, or ask the operator to give ${productKey} an owner`,
            );
          }
          requireOwner(
            tx,
            actor,
            row.productId,
            (owner, key) =>
              `only ${owner}, the owner of ${key}, ${retyping}: comment on ${current.key} with add_comment to ask ${owner}`,
          );
        }
        // what the item is after this update, as a refusal words it
        const becomes =
          type === row.type
            ? `${current.key} is ${aType(type)}`
            : `type ${type} makes ${current.key} ${aType(type)}`;
        if (type === "note") {
          if (status !== undefined && !isNoteStatus(status)) {
            throw new ValidationError(
              `${becomes}, and a note's status is current or archived, not ${status}: send one of those, or type issue or todo to make it work someone does`,
            );
          }
          if (patch.assigneeId != null) {
            throw new ValidationError(
              `${becomes}, and a note has no assignee: file an issue (file_issue) for work someone has to do, and list it in the note's about`,
            );
          }
          if (!holdsANotesRank(patch)) {
            throw new ValidationError(
              `${becomes}, and a note has no priority or estimate: leave both out, and file an issue (file_issue) for work someone has to do, listing it in the note's about`,
            );
          }
          assigneeId = null;
        } else {
          if (status !== undefined && isNoteStatus(status)) {
            throw new ValidationError(
              `${becomes}, and current and archived are a note's statuses: send ${type === "todo" ? "open, in_progress, done or canceled" : "triage, open, in_progress, done or canceled"}, or type note with it to make it a note`,
            );
          }
          if (
            aboutSent !== undefined ||
            addAbout !== undefined ||
            removeAbout !== undefined
          ) {
            throw new ValidationError(
              `${becomes}, and about, addAbout and removeAbout are a note's, the items it is about: add a note about ${current.key} with add_note instead`,
            );
          }
        }
        const filerCancels =
          nextStatus === "canceled" && row.createdBy === actor.id;
        if (
          row.status === "triage" &&
          nextStatus !== "triage" &&
          !filerCancels
        ) {
          requireOwner(
            tx,
            actor,
            row.productId,
            (owner, key) =>
              `${current.key} is in the triage of ${key}, which ${owner} owns: only ${owner} accepts or cancels it, and its filer may cancel it. Comment on it with add_comment to ask ${owner}`,
          );
        }
        // only the owner reopens a canceled issue (below), so an outsider's cancel would be one its filer couldn't undo
        if (
          nextStatus === "canceled" &&
          row.status !== "canceled" &&
          row.createdBy !== actor.id
        ) {
          requireOwner(
            tx,
            actor,
            row.productId,
            (owner, key) =>
              `${current.key} is on ${key}, which ${owner} owns: only ${owner} or the bot that filed it cancels it. Comment on it with add_comment to ask ${owner}`,
          );
        }
        // an issue filed from outside reached canceled through triage or after it, so reopening it decides triage again
        if (
          row.type === "issue" &&
          row.status === "canceled" &&
          nextStatus !== "canceled" &&
          row.createdBy !== ownerIdOf(tx, row.productId)
        ) {
          requireOwner(
            tx,
            actor,
            row.productId,
            (owner, key) =>
              `${current.key} was filed on ${key}, which ${owner} owns, and was canceled: only ${owner} reopens it. Comment on it with add_comment to ask ${owner}`,
          );
        }
        const fields = {
          ...next,
          ...(type === "note" && { priority: 0, estimate: null }),
          type,
          status: nextStatus,
          assigneeId,
        };
        const changes = changesOf<IssueRow>(row, fields);
        // the add and remove forms edit the set read here, under the write lock this transaction holds
        const wantedLabels =
          labelNames ??
          (addLabels === undefined && removeKeys.size === 0
            ? undefined
            : withinIssueCap(
                validLabelNames([
                  ...current.labels.filter((n) => !removeKeys.has(labelKey(n))),
                  ...(addLabels ?? []),
                ]),
                "labels",
              ));
        let labels: Label[] | undefined;
        let skipped: string[] = [];
        if (wantedLabels !== undefined) {
          const ownerId = ownerIdOf(tx, row.productId);
          ({ labels, skipped } = labelsFor(
            tx,
            row.productId,
            wantedLabels,
            ownerId !== null && ownerId !== actor.id,
          ));
          const to = sortedNames(labels);
          if (!sameJson(current.labels, to)) {
            changes.labels = { from: current.labels, to };
          }
        }
        let links = replacementLinks;
        if (
          links === undefined &&
          (addLinks !== undefined || removeUrls.size > 0)
        ) {
          const kept = current.links.filter((l) => !removeUrls.has(l.url));
          for (const added of addLinks ?? []) {
            const at = kept.findIndex((l) => l.url === added.url);
            if (at === -1) kept.push(added);
            else if (!untitled.has(added.url)) {
              kept[at] = added;
            }
          }
          links = withinIssueCap(kept, "links");
        }
        if (links !== undefined && !sameJson(current.links, links)) {
          changes.links = { from: current.links, to: links };
        }
        const aboutIds = wantedAbout(tx, actor, row, type, {
          replace: aboutSent,
          add: addAbout,
          remove: removeAbout,
        });
        const aboutBefore =
          aboutIds === undefined
            ? undefined
            : aboutInEvents(tx, row.id, row.productId);
        if (isEmpty(changes) && aboutBefore === undefined) {
          return { result: withSkipped(current, skipped), event: null };
        }
        const now = new Date();
        const updatedRow = tx
          .update(issue)
          .set({
            ...fields,
            completedAt: completedAtOf(nextStatus, row.completedAt, now),
            updatedAt: now,
          })
          .where(eq(issue.id, row.id))
          .returning()
          .get() as IssueRow;
        if (labels && "labels" in changes) setLabels(tx, row, labels);
        if (links && "links" in changes) setLinks(tx, row.id, links);
        if (aboutIds !== undefined) setAbout(tx, row.id, aboutIds);
        const written = hydrateOne(tx, updatedRow, actor);
        if (aboutBefore) {
          const after = aboutInEvents(tx, row.id, row.productId);
          // a swap among other products' items changes nothing an event can show
          if (
            !sameJson(aboutBefore.keys, after.keys) ||
            aboutBefore.others !== after.others
          ) {
            changes.about = { from: aboutBefore.keys, to: after.keys };
            changes.aboutOthers = {
              from: aboutBefore.others,
              to: after.others,
            };
          }
        }
        return {
          result: withSkipped(written, skipped),
          event: isEmpty(changes)
            ? null
            : {
                actorId: actor.id,
                subjectType: "issue",
                subjectId: row.id,
                productId: row.productId,
                action: "issue.updated",
                payload: changes,
              },
        };
      });
      return withPullRequest(updated);
    },

    addComment(
      actor: ActingActor,
      input: CommentInput,
      options: WriteOptions = {},
    ): Comment {
      requireAction(actor, "comments", "comment on an item", () =>
        resolveIssueRow(db, input.issueId, actor),
      );
      if (input.body.trim() === "") {
        throw new ValidationError("body must not be empty");
      }
      const externalRef = optionalRef(input.externalRef);
      return create(actor, options, "comment.create", (tx) => {
        const target = resolveIssueRow(tx, input.issueId, actor);
        const fields = {
          issueId: target.id,
          body: input.body,
          externalRef,
        };
        return {
          request: fields,
          write: () => {
            if (externalRef !== null) {
              const twin = tx
                .select({ id: comment.id })
                .from(comment)
                .where(
                  and(
                    eq(comment.issueId, target.id),
                    eq(comment.externalRef, externalRef),
                  ),
                )
                .get();
              if (twin) {
                throw new ConflictError(
                  `externalRef ${externalRef} is already on comment ${twin.id} of this item: it is posted already, or send a different externalRef`,
                );
              }
            }
            const created = tx
              .insert(comment)
              .values({ ...fields, authorId: actor.id })
              .returning()
              .get();
            return {
              result: created,
              event: {
                actorId: actor.id,
                subjectType: "comment",
                subjectId: created.id,
                productId: target.productId,
                action: "comment.created",
                payload: {
                  issueId: target.id,
                  body: created.body,
                  externalRef: created.externalRef,
                },
              },
            };
          },
        };
      });
    },

    /** Posts a status update on exactly one of a product and a project. */
    createStatusUpdate(
      actor: ActingActor,
      input: StatusUpdateInput,
      options: WriteOptions = {},
    ): StatusUpdate {
      const target = statusTargetOf(input, "post_status_update");
      requireBot(actor, "post a status update");
      requireAction(actor, "status_updates", "post a status update", () =>
        "product" in target
          ? resolveProduct(db, target.product, actor)
          : resolveProject(db, target.project, actor),
      );
      const body = input.body;
      if (body.trim() === "") {
        throw new ValidationError("body must not be empty");
      }
      const health = validHealth(input.health);
      const externalRef = optionalRef(input.externalRef);
      if ("project" in target && externalRef !== null) {
        throw new ValidationError(
          "externalRef is kept on a product's status update only: drop externalRef to post on the project, and send an idempotency key (the Idempotency-Key header over REST, idempotency_key over MCP) to make the post safe to retry",
        );
      }
      return create(actor, options, "status_update.create", (tx) => {
        if ("project" in target) {
          const into = resolveProject(tx, target.project, actor);
          return {
            request: { projectId: into.id, body, health },
            write: () => {
              const created = tx
                .insert(projectStatusUpdate)
                .values({
                  projectId: into.id,
                  body,
                  health,
                  authorId: actor.id,
                })
                .returning()
                .get();
              return {
                result: statusUpdateViews(tx, [created])[0] as StatusUpdate,
                event: {
                  actorId: actor.id,
                  subjectType: "status_update",
                  subjectId: created.id,
                  projectId: into.id,
                  action: "status_update.created",
                  payload: { body, health, project: into.slug },
                },
              };
            },
          };
        }
        const into = resolveProduct(tx, target.product, actor);
        return {
          // projectId, the key requests stored before products were named, so a retry across the rename replays
          request: { projectId: into.id, body, health, externalRef },
          write: () => {
            if (externalRef !== null) {
              const twin = tx
                .select({ id: productStatusUpdate.id })
                .from(productStatusUpdate)
                .where(
                  and(
                    eq(productStatusUpdate.productId, into.id),
                    eq(productStatusUpdate.externalRef, externalRef),
                  ),
                )
                .get();
              if (twin) {
                throw new ConflictError(
                  `externalRef ${externalRef} is already on status update ${twin.id} of product ${into.key}: it is posted already, or send a different externalRef`,
                );
              }
            }
            const created = tx
              .insert(productStatusUpdate)
              .values({
                productId: into.id,
                body,
                health,
                externalRef,
                authorId: actor.id,
              })
              .returning()
              .get();
            return {
              result: statusUpdateViews(tx, [created])[0] as StatusUpdate,
              event: {
                actorId: actor.id,
                subjectType: "status_update",
                subjectId: created.id,
                productId: into.id,
                action: "status_update.created",
                payload: { body, health, externalRef },
              },
            };
          },
        };
      });
    },

    createLabel(
      actor: ActingActor,
      input: LabelInput,
      options: WriteOptions = {},
    ): Label {
      requireBot(actor, "create a label");
      requireAction(actor, "admin", "create a label", () =>
        resolveProduct(db, input.productId, actor),
      );
      const name = nonBlank(input.name, "name");
      return create(actor, options, "label.create", (tx) => {
        const target = resolveProduct(tx, input.productId, actor);
        const authorize = () =>
          requireOwner(
            tx,
            actor,
            target.id,
            (owner, key) =>
              `${key} is owned by ${owner}, so only ${owner} creates its labels: ask ${owner} to create the label "${name}", or file or update the item without it, and a label ${key} lacks comes back in skippedLabels`,
          );
        return {
          // projectId, as requests were stored before products were named
          request: { projectId: target.id, name },
          replay: authorize,
          write: () => {
            authorize();
            const twin = findLabel(tx, target.id, name);
            if (twin) {
              throw new ConflictError(
                `product ${target.key} already has the label "${twin.name}": use it as it is, since label names match ignoring the case of A-Z`,
              );
            }
            const created = tx
              .insert(label)
              .values({ productId: target.id, name })
              .returning()
              .get();
            return {
              result: created,
              event: {
                actorId: actor.id,
                subjectType: "label",
                subjectId: created.id,
                productId: target.id,
                action: "label.created",
                payload: { name },
              },
            };
          },
        };
      });
    },

    /**
     * Creates a project drawing from `products` (the caller's own product when
     * it names none and owns exactly one), led by `lead` (the caller by default).
     */
    createProject(
      actor: ActingActor,
      input: ProjectInput,
      options: WriteOptions = {},
    ): ProjectView {
      requireBot(actor, "create a project");
      requireAction(actor, "issues", "create a project", () => {
        for (const ref of input.products ?? []) resolveProduct(db, ref, actor);
      });
      const name = nonBlank(input.name, "name");
      const slug = input.slug === undefined ? undefined : validSlug(input.slug);
      const targetDate = validTargetDate(input.targetDate) ?? null;
      if (input.products?.length === 0) {
        throw new ValidationError(
          "products must name at least one product: send product keys like TRL, or leave products out to use the one product you own",
        );
      }
      if ((input.products?.length ?? 0) > PROJECT_PRODUCTS_MAX) {
        throw new ValidationError(
          `products names ${input.products?.length} products, over the limit of ${PROJECT_PRODUCTS_MAX}`,
        );
      }
      const row = create(actor, options, "project_group.create", (tx) => {
        const named = input.products?.map(
          (ref) => resolveProduct(tx, ref, actor).id,
        );
        const lead =
          input.lead === undefined
            ? undefined
            : resolveBot(tx, input.lead, "lead").id;
        const fields = { name, goal: input.goal ?? "", targetDate };
        return {
          // as sent: the product a create naming none defaults to can change before a retry
          request: {
            ...fields,
            leadId: lead,
            slug: slug ?? null,
            productIds: named && [...new Set(named)].sort(),
          },
          replay: (stored: ProjectRow) => {
            resolveProject(tx, stored.slug, actor);
          },
          write: () => {
            const productIds = [
              ...new Set(
                named ?? [
                  defaultProduct(tx, actor, "create_project", "products").id,
                ],
              ),
            ];
            if (
              slug !== undefined &&
              tx
                .select({ id: project.id })
                .from(project)
                .where(eq(project.slug, slug))
                .get()
            ) {
              throw new ConflictError(
                `slug ${slug} is taken by another project: choose another slug, or leave slug out to derive a free one from the name`,
              );
            }
            const keyed =
              slug === undefined ? undefined : productKeyedAs(tx, slug);
            if (keyed) {
              throw new ConflictError(
                `slug ${slug} is the key of product ${keyed.key}, and a project's slug never matches a product's key: pick another slug, or leave slug out to derive a free one from the name`,
              );
            }
            const created = tx
              .insert(project)
              .values({
                ...fields,
                leadId: lead ?? actor.id,
                slug: slug ?? freeSlug(tx, slugOfName(name)),
                createdBy: actor.id,
              })
              .returning()
              .get();
            tx.insert(projectProduct)
              .values(
                productIds.map((productId) => ({
                  projectId: created.id,
                  productId,
                })),
              )
              .run();
            return {
              result: created,
              event: {
                actorId: actor.id,
                subjectType: "project",
                subjectId: created.id,
                projectId: created.id,
                action: "project.created",
                payload: {
                  slug: created.slug,
                  name: created.name,
                  goal: created.goal,
                  leadId: created.leadId,
                  targetDate: created.targetDate,
                },
              },
            };
          },
        };
      });
      return projectView(db, row, actor);
    },

    /** A patch that changes nothing writes nothing and emits no event. */
    updateProject(
      actor: ActingActor,
      slug: string,
      patch: ProjectPatch,
    ): ProjectView {
      requireProjectWrite(actor, "update a project", slug);
      const name =
        patch.name === undefined ? undefined : nonBlank(patch.name, "name");
      const targetDate = validTargetDate(patch.targetDate);
      return commit((tx) => {
        const current = resolveProject(tx, slug, actor);
        const next = {
          name,
          goal: patch.goal,
          leadId:
            patch.lead === undefined
              ? undefined
              : resolveBot(tx, patch.lead, "lead").id,
          targetDate,
        };
        const changes = changesOf(current, next);
        if (isEmpty(changes)) {
          return { result: projectView(tx, current, actor), event: null };
        }
        const updated = tx
          .update(project)
          .set(next)
          .where(eq(project.id, current.id))
          .returning()
          .get() as ProjectRow;
        return {
          result: projectView(tx, updated, actor),
          event: {
            actorId: actor.id,
            subjectType: "project",
            subjectId: current.id,
            projectId: current.id,
            action: "project.updated",
            payload: changes,
          },
        };
      });
    },

    getProject(actor: ActingActor, slug: string): ProjectView {
      requireAction(actor, "read", "read a project", () =>
        resolveProject(db, slug, actor),
      );
      return projectView(db, resolveProject(db, slug, actor), actor);
    },

    /** A project by exact slug, else a product by key: the meaning `project` had before projects. */
    getProjectOrProduct(
      actor: ActingActor,
      ref: string,
    ): ProjectOrProduct<ProductView | NamedProduct> {
      requireAction(actor, "read", "read a project", () =>
        resolveProjectOrProduct(db, ref, actor),
      );
      const found = resolveProjectOrProduct(db, ref, actor);
      return "project" in found
        ? { kind: "project", project: projectView(db, found.project, actor) }
        : {
            kind: "product",
            product: productReads(actor, [found.product])[0] as
              | ProductView
              | NamedProduct,
          };
    },

    /**
     * create_project and POST /projects: with `key` the deprecated create of a
     * product, else a project. A mix of the two field sets is refused.
     */
    createProjectOrProduct(
      actor: ActingActor,
      input: ProjectInput & {
        key?: string;
        description?: string;
        externalRef?: string | null;
      },
      options: WriteOptions = {},
    ): ProjectOrProduct {
      const { key, description, externalRef, ...fields } = input;
      if (key === undefined) {
        if (description !== undefined || externalRef !== undefined) {
          throw new ValidationError(
            "description and externalRef go with key, which creates a product: send goal to describe a project, or use create_product (POST /products) for a product",
          );
        }
        return {
          kind: "project",
          project: this.createProject(actor, fields, options),
        };
      }
      const projectOnly = (
        ["slug", "goal", "lead", "targetDate", "products"] as const
      ).filter((f) => fields[f] !== undefined);
      if (projectOnly.length > 0) {
        throw new ValidationError(
          `key creates a product (deprecated), and ${andList(projectOnly)} create a project: drop key to create a project, or use create_product (POST /products) for a product`,
        );
      }
      return {
        kind: "product",
        product: this.createProduct(
          actor,
          { name: fields.name, key, description, externalRef },
          options,
        ),
      };
    },

    /** update_project and PATCH /projects/{ref}: a project by slug, else a product by key with its name and description. */
    updateProjectOrProduct(
      actor: ActingActor,
      ref: string,
      patch: ProjectPatch & { description?: string },
    ): ProjectOrProduct {
      const { description, ...fields } = patch;
      if (this.whichProjectRef(actor, ref) === "project") {
        if (description !== undefined) {
          throw new ValidationError(
            `${ref} is a project, which has a goal, not a description: send goal instead`,
          );
        }
        return {
          kind: "project",
          project: this.updateProject(actor, ref, fields),
        };
      }
      const projectOnly = (["goal", "lead", "targetDate"] as const).filter(
        (f) => fields[f] !== undefined,
      );
      if (projectOnly.length > 0) {
        throw new ValidationError(
          `${ref} is a product, which has no ${andList(projectOnly)}: change a product with update_product (PATCH /products/{key}), or name a project by its slug`,
        );
      }
      return {
        kind: "product",
        product: this.updateProduct(actor, ref, {
          name: fields.name,
          description,
        }),
      };
    },

    /** Whether `ref` names a project (exact slug) or, by the legacy meaning, a product; neither the caller reaches is a 404. */
    whichProjectRef(actor: ActingActor, ref: string): "project" | "product" {
      return "project" in resolveProjectOrProduct(db, ref, actor)
        ? "project"
        : "product";
    },

    /** Newest first; only projects drawing from a product the caller reaches. */
    listProjects(actor: ActingActor, query: PageQuery = {}): Page<ProjectView> {
      requireAction(actor, "read", "list projects");
      const found = page(
        project,
        "desc",
        query,
        [reachableProjects(actor)],
        (where, orderBy, limit) =>
          db
            .select()
            .from(project)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
      return { ...found, items: projectViews(db, found.items, actor) };
    },

    /**
     * Adds items to a project, each item's product joining the project's
     * products when it isn't one yet. An item already in it is left as it is.
     */
    addToProject(
      actor: ActingActor,
      slug: string,
      itemRefs: string[],
    ): { project: ProjectView; added: string[]; unchanged: string[] } {
      validItemRefs(itemRefs, "add_to_project");
      const takes = "add_to_project (POST /projects/{slug}/items)";
      requireProjectWrite(actor, "add items to a project", slug, takes);
      return commit((tx) => {
        const target = resolveProject(tx, slug, actor, takes);
        const items = hydrate(
          tx,
          [
            ...new Map(
              itemRefs
                .map((ref) => resolveIssueRow(tx, ref, actor))
                .map((row) => {
                  requireItemWrite(tx, actor, row, "add it to a project");
                  return [row.id, row] as const;
                }),
            ).values(),
          ],
          actor,
        );
        const products = new Set(
          tx
            .select({ id: projectProduct.productId })
            .from(projectProduct)
            .where(eq(projectProduct.projectId, target.id))
            .all()
            .map((p) => p.id),
        );
        const inProject = new Set(
          tx
            .select({ id: projectItem.issueId })
            .from(projectItem)
            .where(
              and(
                eq(projectItem.projectId, target.id),
                inArray(
                  projectItem.issueId,
                  items.map((i) => i.id),
                ),
              ),
            )
            .all()
            .map((i) => i.id),
        );
        const events: NewEvent[] = [];
        const added: string[] = [];
        const unchanged: string[] = [];
        for (const item of items) {
          if (!inProject.has(item.id) && !products.has(item.productId)) {
            requireProductGrant(
              tx,
              actor,
              item.productId,
              (key) =>
                `adding ${item.key} to project ${target.slug} would draw ${target.slug} from product ${key}: to add it, the bot needs a key that lists product ${key}.`,
            );
          }
        }
        for (const item of items) {
          if (inProject.has(item.id)) {
            unchanged.push(item.key);
            continue;
          }
          if (!products.has(item.productId)) {
            tx.insert(projectProduct)
              .values({ projectId: target.id, productId: item.productId })
              .run();
            products.add(item.productId);
          }
          tx.insert(projectItem)
            .values({
              projectId: target.id,
              issueId: item.id,
              productId: item.productId,
              addedBy: actor.id,
            })
            .run();
          added.push(item.key);
          events.push(
            membership(actor, target, item, "project.item_added", item.key),
          );
        }
        if (added.length > 0) touchProject(tx, target.id);
        return {
          result: { project: projectView(tx, target, actor), added, unchanged },
          event: events,
        };
      });
    },

    /** Takes items out of a project; one not in it is left as it is. The project keeps its products. */
    removeFromProject(
      actor: ActingActor,
      slug: string,
      itemRefs: string[],
    ): { project: ProjectView; removed: string[]; unchanged: string[] } {
      validItemRefs(itemRefs, "remove_from_project");
      const takes = "remove_from_project (DELETE /projects/{slug}/items/{key})";
      requireProjectWrite(actor, "remove items from a project", slug, takes);
      return commit((tx) => {
        const target = resolveProject(tx, slug, actor, takes);
        const items = hydrate(
          tx,
          [
            ...new Map(
              itemRefs
                .map((ref) => resolveIssueRow(tx, ref, actor))
                .map((row) => {
                  requireItemWrite(tx, actor, row, "remove it from a project");
                  const isMember =
                    tx
                      .select({ one: sql`1` })
                      .from(projectItem)
                      .where(
                        and(
                          eq(projectItem.projectId, target.id),
                          eq(projectItem.issueId, row.id),
                        ),
                      )
                      .get() !== undefined;
                  // a non-member is listed unchanged, which needs no grant
                  if (isMember && !projectIdsOf(actor)?.includes(target.id)) {
                    requireProductGrant(
                      tx,
                      actor,
                      row.productId,
                      (key) =>
                        `${key}-${row.number} is in project ${target.slug}, which this key reads only through its products: to remove it from ${target.slug}, the bot needs a key that lists ${grantsFor(key, [target.slug])}.`,
                    );
                  }
                  return [row.id, row] as const;
                }),
            ).values(),
          ],
          actor,
        );
        const events: NewEvent[] = [];
        const removed: string[] = [];
        const unchanged: string[] = [];
        for (const item of items) {
          const gone = tx
            .delete(projectItem)
            .where(
              and(
                eq(projectItem.projectId, target.id),
                eq(projectItem.issueId, item.id),
              ),
            )
            .run().changes;
          if (gone === 0) {
            unchanged.push(item.key);
            continue;
          }
          removed.push(item.key);
          events.push(
            membership(actor, target, item, "project.item_removed", item.key),
          );
        }
        if (removed.length > 0) touchProject(tx, target.id);
        return {
          result: {
            project: projectView(tx, target, actor),
            removed,
            unchanged,
          },
          event: events,
        };
      });
    },

    /**
     * Upserts a product and its rows by externalRef in one transaction: a new
     * row is created, a changed one updated, an identical one left untouched
     * (updatedAt included), and nothing missing from the payload is deleted.
     * One product.imported event carries the counts; a run that changes
     * nothing writes none.
     */
    importProject(actor: ActingActor, payload: ImportPayload): ImportResult {
      requireBot(actor, "import a product");
      requireAction(actor, "admin", "import a product");
      const input = normalImport(payload);
      return commit((tx) => {
        const tally: Tally = {
          created: zeroCounts(),
          updated: zeroCounts(),
          unchanged: zeroCounts(),
        };
        const now = new Date();
        const target = importProjectRow(tx, actor, input, tally);
        const labels = importLabels(tx, target.id, input.labels, tally);
        const existing = new Map(
          hydrate(
            tx,
            tx
              .select()
              .from(issue)
              .where(
                and(
                  eq(issue.productId, target.id),
                  isNotNull(issue.externalRef),
                ),
              )
              .all(),
            actor,
          ).map((i) => [i.externalRef, i]),
        );
        const { numbers, renumbered } = importNumbers(
          tx,
          target,
          input.issues.filter((row) => !existing.has(row.externalRef)),
        );
        for (const row of input.issues) {
          const issueId = importIssue(
            tx,
            actor,
            target,
            row,
            existing.get(row.externalRef),
            numbers.get(row.externalRef),
            labels,
            tally,
            now,
          );
          importComments(tx, actor, issueId, row.comments, tally);
        }
        importStatusUpdates(tx, actor, target.id, input.statusUpdates, tally);

        const result: ImportResult = {
          product: productView(
            tx,
            tx
              .select()
              .from(product)
              .where(eq(product.id, target.id))
              .get() as Product,
          ),
          renumbered,
          ...tally,
        };
        const wrote = [tally.created, tally.updated].some((counts) =>
          Object.values(counts).some((n) => n > 0),
        );
        if (!wrote) return { result, event: null };
        const payload = {
          externalRef: target.externalRef,
          ...tally,
          renumbered,
        };
        payload satisfies z.input<typeof importedEventPayload>;
        return {
          result,
          event: {
            actorId: actor.id,
            subjectType: "product",
            subjectId: target.id,
            productId: target.id,
            action: "product.imported",
            payload,
          },
        };
      });
    },

    /** The item with the notes about it; `legacy`, for get_issue and GET /issues, finds no note. */
    getItem(
      actor: ActingActor,
      ref: string,
      { legacy = false }: { legacy?: boolean } = {},
    ): Issue {
      const find = () =>
        legacy ? workRow(db, ref, actor) : resolveIssueRow(db, ref, actor);
      requireAction(actor, "read", "read an item", find);
      const row = find();
      const found = withPullRequest(hydrateOne(db, row, actor));
      const item = legacy
        ? found
        : {
            ...found,
            notes: notesAbout(db, row.id, actor),
            notesCount: notesCountAbout(db, row.id, actor),
          };
      return actor.kind === "bot"
        ? { ...item, access: accessOf(db, actor, row) }
        : item;
    },

    /** These links of an item the caller has already found visible, each pull request link with its cached state as pr, as `getItem` gives them. */
    withPullRequestLinks(links: Issue["links"]): Issue["links"] {
      return withPullRequest({ links }).links;
    },

    /** The legacy list_issues: status open also lists issues waiting in triage, which did not exist when it was named. */
    listIssues(actor: ActingActor, query: ItemQuery = {}): Page<Issue> {
      return this.listItems(actor, {
        ...query,
        status: query.status === "open" ? ["triage", "open"] : query.status,
      });
    },

    /**
     * Newest first, filtered by any of product, project, type, status,
     * assignee and the item notes are about. Without `type`, issues and todos
     * only: notes need type note or `about`.
     */
    listItems(actor: ActingActor, query: ItemQuery = {}): Page<Issue> {
      requireAction(actor, "read", "list items", () => {
        if (query.product !== undefined)
          resolveNamedProduct(db, query.product, actor);
        if (query.project !== undefined)
          resolveProject(db, query.project, actor);
      });
      if (
        query.about !== undefined &&
        query.type !== undefined &&
        query.type !== "note"
      ) {
        throw new ValidationError(
          `about lists the notes about an item, so it takes type note or no type, not ${query.type}: leave type out, or drop about to list ${query.type}s`,
        );
      }
      const type = query.about === undefined ? query.type : "note";
      const statuses =
        query.status === undefined
          ? []
          : typeof query.status === "string"
            ? [validStatus(query.status)]
            : query.status.map(validStatus);
      for (const status of statuses) {
        if (type === "note" && !isNoteStatus(status)) {
          throw new ValidationError(
            query.about === undefined
              ? `a note's status is current or archived, so type note takes status current or archived, not ${status}`
              : `about lists notes, and a note's status is current or archived, not ${status}`,
          );
        }
        if (type !== "note" && isNoteStatus(status)) {
          throw new ValidationError(
            query.type === undefined
              ? `status ${status} is a note's, and list_items without type lists issues and todos: send type note with it`
              : `status ${status} is a note's, and ${aType(query.type)} is never ${status}: send type note with it`,
          );
        }
      }
      const inProject =
        query.project === undefined
          ? undefined
          : resolveProject(db, query.project, actor);
      const aboutId =
        query.about === undefined
          ? undefined
          : aboutTarget(query.about, actor).id;
      const filters = [
        itemsReached(db, reachFor(actor), issue.id, issue.productId),
        query.product === undefined
          ? undefined
          : eq(
              issue.productId,
              resolveNamedProduct(db, query.product, actor).id,
            ),
        inProject === undefined
          ? undefined
          : inArray(
              issue.id,
              db
                .select({ id: projectItem.issueId })
                .from(projectItem)
                .where(eq(projectItem.projectId, inProject.id)),
            ),
        type === undefined
          ? inArray(issue.type, workTypes)
          : eq(issue.type, type),
        aboutId === undefined
          ? undefined
          : inArray(
              issue.id,
              db
                .select({ id: noteAbout.noteId })
                .from(noteAbout)
                .where(eq(noteAbout.itemId, aboutId)),
            ),
        statuses.length > 0
          ? inArray(issue.status, statuses)
          : // every note status, the same rows as type note by issue_note_status_check, so
            // issue_product_status_created_idx serves the page instead of a walk of the product
            type === "note"
            ? inArray(issue.status, [...noteStatuses])
            : undefined,
        query.assignee === undefined
          ? undefined
          : eq(
              issue.assigneeId,
              resolveAssignee(db, query.assignee, "to filter by"),
            ),
      ];
      const rows = page(
        issue,
        "desc",
        query,
        filters,
        (where, orderBy, limit) =>
          db
            .select()
            .from(issue)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
      return {
        items: withPullRequests(hydrate(db, rows.items, actor)),
        nextCursor: rows.nextCursor,
      };
    },

    /** Oldest first, the order an item's thread reads in. */
    listComments(
      actor: ActingActor,
      issueRef: string,
      query: PageQuery = {},
    ): Page<Comment> {
      requireAction(actor, "read", "list comments", () =>
        resolveIssueRow(db, issueRef, actor),
      );
      const target = resolveIssueRow(db, issueRef, actor);
      return page(
        comment,
        "asc",
        query,
        [eq(comment.issueId, target.id)],
        (where, orderBy, limit) =>
          db
            .select()
            .from(comment)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
    },

    /** Newest first, of exactly one of a product and a project. */
    listStatusUpdates(
      actor: ActingActor,
      of: StatusTarget,
      query: PageQuery = {},
    ): Page<StatusUpdate> {
      const target = statusTargetOf(of, "list_status_updates");
      requireAction(actor, "read", "list status updates", () =>
        "product" in target
          ? resolveProduct(db, target.product, actor)
          : resolveProject(db, target.project, actor),
      );
      if ("project" in target) {
        const into = resolveProject(db, target.project, actor);
        const found = page(
          projectStatusUpdate,
          "desc",
          query,
          [eq(projectStatusUpdate.projectId, into.id)],
          (where, orderBy, limit) =>
            db
              .select()
              .from(projectStatusUpdate)
              .where(where)
              .orderBy(...orderBy)
              .limit(limit)
              .all(),
        );
        return { ...found, items: statusUpdateViews(db, found.items) };
      }
      const into = resolveProduct(db, target.product, actor);
      const found = page(
        productStatusUpdate,
        "desc",
        query,
        [eq(productStatusUpdate.productId, into.id)],
        (where, orderBy, limit) =>
          db
            .select()
            .from(productStatusUpdate)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
      return { ...found, items: statusUpdateViews(db, found.items) };
    },

    /** Oldest first. */
    listLabels(
      actor: ActingActor,
      productRef: string,
      query: PageQuery = {},
    ): Page<Label> {
      requireAction(actor, "read", "list labels", () =>
        resolveLabeledProduct(db, productRef, actor),
      );
      const target = resolveLabeledProduct(db, productRef, actor);
      return page(
        label,
        "asc",
        query,
        [eq(label.productId, target.id)],
        (where, orderBy, limit) =>
          db
            .select()
            .from(label)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
    },

    /**
     * The calling actor, as stored, with its photo URL, the products it owns,
     * those it files on, the projects it reads through its products and its
     * team, or a hint when it owns nothing;
     * actors are never deleted, so the row is there.
     */
    whoami(actor: ActingActor): Whoami {
      const owned = everythingOwnedBy(db, actor.id);
      return {
        ...withPhotoUrl(
          selectWithPhotoHash()
            .where(eq(actorTable.id, actor.id))
            .get() as ActorWithHash,
        ),
        ownProducts: ownProductsOf(db, actor),
        products: fileableProducts(db, actor),
        impliedProjects: implicitProjectsOf(db, actor).map((p) => p.slug),
        unreadMessages: messaging.unreadMessages(actor),
        team: owned.find((p) => p.kind === "team") ?? null,
        ...(owned.length === 0 && { hint: ownsNothingHint(actor.scope) }),
      };
    },

    /** Every bot, oldest first. */
    listBots(actor: ActingActor, query: PageQuery = {}): Page<ActorWithPhoto> {
      requireAction(actor, "admin", "list bots");
      const found = page(
        actorTable,
        "asc",
        query,
        [eq(actorTable.kind, "bot")],
        (where, orderBy, limit) =>
          selectWithPhotoHash()
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
      return { ...found, items: found.items.map(withPhotoUrl) };
    },

    /**
     * Stores the calling actor's photo and, when the stored photo changed,
     * publishes it to live actor subscribers; see `setActorPhoto` for what it
     * refuses. Any key may.
     */
    setMyPhoto(actor: ActingActor, bytes: Uint8Array): { photoUrl: string } {
      const { photoUrl, changed } = setActorPhoto(db, actor.id, bytes);
      if (changed) publishActor(actor.id);
      return { photoUrl };
    },

    /** Removes the calling actor's photo, if it has one, and publishes the removal. Any key may. */
    clearMyPhoto(actor: ActingActor): { photoUrl: null } {
      if (clearActorPhoto(db, actor.id)) publishActor(actor.id);
      return { photoUrl: null };
    },

    /** Sets the calling bot's title, trimmed, and publishes it when it changed. Any bot key may. */
    setMyTitle(actor: ActingActor, raw: string): { title: string } {
      requireBot(actor, "set a title");
      const title = validBotTitle(raw);
      setTitle(actor.id, title);
      return { title };
    },

    /** Clears the calling bot's title, publishing the removal when it had one. Any bot key may. */
    clearMyTitle(actor: ActingActor): { title: null } {
      requireBot(actor, "clear a title");
      setTitle(actor.id, null);
      return { title: null };
    },

    /**
     * In commit order (`seq`): newest first with `cursor`, oldest first after
     * `after`. Either cursor is bound to the filters and the parameter it was
     * issued under.
     */
    listActivity(
      actor: ActingActor,
      query: ActivityQuery = {},
    ): Page<ActivityEntry> {
      requireAction(actor, "read", "read the activity feed", () => {
        if (query.product !== undefined)
          resolveNamedProduct(db, query.product, actor);
        if (query.project !== undefined)
          resolveProject(db, query.project, actor);
      });
      if (query.cursor !== undefined && query.after !== undefined) {
        throw new ValidationError(
          "send cursor (newest first) or after (oldest first), not both",
        );
      }
      const limit = pageLimit(query.limit);
      const named =
        query.product === undefined
          ? undefined
          : resolveNamedProduct(db, query.product, actor);
      const group =
        query.project === undefined
          ? undefined
          : resolveProject(db, query.project, actor);
      const filters: FeedFilters = {
        projectId: named?.id ?? null,
        productKey: named?.key ?? null,
        actorId: query.actorId ?? null,
        groupId: group?.id ?? null,
        projectSlug: group?.slug ?? null,
      };
      const reach = reachFor(actor);
      const where: (SQL | undefined)[] = [
        eventsReached(db, reach),
        filters.projectId === null
          ? undefined
          : eq(activityEvent.productId, filters.projectId),
        filters.groupId == null
          ? undefined
          : eq(activityEvent.projectId, filters.groupId),
        filters.actorId === null
          ? undefined
          : eq(activityEvent.actorId, filters.actorId),
      ];
      const select = (order: SQL, max: number, afterSeq?: number) =>
        db
          .select({
            ...getTableColumns(activityEvent),
            productKey: product.key,
            projectSlug: project.slug,
          })
          .from(activityEvent)
          .leftJoin(product, eq(product.id, activityEvent.productId))
          .leftJoin(project, eq(project.id, activityEvent.projectId))
          .where(
            and(
              ...where,
              afterSeq === undefined
                ? undefined
                : gt(activityEvent.seq, afterSeq),
            ),
          )
          .orderBy(order)
          .limit(max)
          .all();
      // the cursor steps past an event the key reads as nothing, so it is dropped after paging
      const readable = (events: ReturnType<typeof select>) =>
        events.flatMap((event) => eventForReach(db, reach, event) ?? []);

      if (query.after !== undefined) {
        const from =
          query.after === ""
            ? 0
            : decodeFeedCursor(query.after, filters, "after");
        // an empty page promises nothing new, so a full page the key reads as nothing reads on
        let seq = from;
        for (;;) {
          const rows = select(asc(activityEvent.seq), limit, seq);
          seq = rows.at(-1)?.seq ?? seq;
          const items = readable(rows);
          if (items.length > 0 || rows.length < limit)
            return {
              items,
              nextCursor: encodeFeedCursor({ ...filters, seq, param: "after" }),
            };
        }
      }

      if (query.cursor !== undefined) {
        where.push(
          lt(
            activityEvent.seq,
            decodeFeedCursor(query.cursor, filters, "cursor"),
          ),
        );
      }
      const rows = select(desc(activityEvent.seq), limit + 1);
      const last = rows.slice(0, limit).at(-1);
      return {
        items: readable(rows.slice(0, limit)),
        nextCursor:
          rows.length > limit && last
            ? encodeFeedCursor({ ...filters, seq: last.seq, param: "cursor" })
            : null,
      };
    },

    // Webhooks. A subscription belongs to the bot, so every call below names only the
    // calling bot's own; one that follows a product outside the key's scope is as
    // missing to that key as a product it can't see.

    async createWebhook(
      actor: ActingActor,
      input: {
        url: string;
        secret: string;
        kind?: WebhookSubscriptionKind;
      } & Follows,
    ): Promise<WebhookWritten> {
      const kind = input.kind ?? "activity";
      requireBot(
        actor,
        kind === "inbox" ? "subscribe to an inbox" : "subscribe to a product",
      );
      // an inbox webhook is messaging, which no key's actions limit
      if (kind === "activity") requireAction(actor, "read", "create a webhook");
      validSecret(input.secret);
      if (kind === "inbox" && followsSent(input)) {
        throw new ValidationError(
          "an inbox webhook follows no products or projects: leave products and projects out, and create a second webhook with kind activity for their events",
        );
      }
      const follows =
        kind === "inbox"
          ? { productIds: [], projectIds: [], productAlias: false }
          : webhookFollows(actor, input);
      const productIds = follows.productIds ?? [];
      const projectIds = follows.projectIds ?? [];
      if (
        kind === "activity" &&
        productIds.length === 0 &&
        projectIds.length === 0
      ) {
        throw new ValidationError(
          `${followsSent(input) ? "products and projects name nothing" : "products or projects is required"}: send products with the keys (like TRL) of the products whose events you want, or projects with the slugs (like launch-q4) of projects (list_projects lists them), or send kind inbox for the messages other bots send you`,
        );
      }
      const refuseAtLimit = (from: Db | Tx) => {
        const count = countOwn(from, actor.id);
        if (count >= WEBHOOKS_PER_BOT_MAX) {
          // a count or advice about webhooks this key can't see would describe them
          const own = from
            .select()
            .from(webhookSubscription)
            .where(eq(webhookSubscription.actorId, actor.id))
            .all();
          if (!webhooksOf(from, own).every((w) => canManage(actor, w))) {
            throw new ConflictError(
              `this bot has reached its limit of ${WEBHOOKS_PER_BOT_MAX} webhooks, and this key can't manage all of them: a key that can read every product the bot follows can delete one to make room`,
            );
          }
          throw new ConflictError(
            kind === "inbox"
              ? `this bot already has ${count} webhooks, the most allowed: delete one you no longer use to make room for the inbox webhook`
              : `this bot already has ${count} webhooks, the most allowed: delete one you no longer use, or add the product to one you have with update_webhook`,
          );
        }
      };
      refuseAtLimit(db);
      const { url } = await checkedUrl(input.url);
      return db.transaction(
        (tx) => {
          // again under the write lock: creates sent together all passed the check above
          refuseAtLimit(tx);
          const twin = tx
            .select({ id: webhookSubscription.id })
            .from(webhookSubscription)
            .where(
              and(
                eq(webhookSubscription.actorId, actor.id),
                eq(webhookSubscription.url, url.href),
              ),
            )
            .get();
          if (twin) {
            throw twinConflict(
              actor,
              twin.id,
              tx,
              "change it with update_webhook, or use a different URL",
            );
          }
          const row = insertSubscription(tx, webhooks, {
            kind,
            actorId: actor.id,
            apiKeyId: actor.keyId ?? null,
            url: url.href,
            secret: input.secret,
            productIds,
            projectIds,
          });
          const view = webhooksOf(tx, [row])[0] as Webhook;
          return { ...view, productAlias: follows.productAlias };
        },
        { behavior: "immediate" },
      );
    },

    listWebhooks(actor: ActingActor): Page<Webhook> {
      requireBot(actor, "list webhooks");
      const actions = actor.scope?.actions;
      // without the read action, a key still manages the inbox webhooks
      const inboxOnly = actions != null && !actions.includes("read");
      const rows = db
        .select()
        .from(webhookSubscription)
        .where(
          and(
            eq(webhookSubscription.actorId, actor.id),
            inboxOnly ? eq(webhookSubscription.kind, "inbox") : undefined,
          ),
        )
        .orderBy(
          asc(webhookSubscription.createdAt),
          asc(webhookSubscription.id),
        )
        .all();
      return {
        items: webhooksOf(db, rows).filter((w) => withinScope(actor, w)),
        nextCursor: null,
      };
    },

    getWebhook(actor: ActingActor, id: string): Webhook {
      requireBot(actor, "read a webhook");
      return requireWebhookAction(actor, id, "read a webhook").view;
    },

    /** Changes the URL or the followed products and projects; any update, an empty one too, ends a pause. */
    async updateWebhook(
      actor: ActingActor,
      id: string,
      patch: { url?: string } & Follows,
    ): Promise<WebhookWritten> {
      requireBot(actor, "update a webhook");
      const current = requireWebhookAction(actor, id, "update a webhook").view;
      if (current.kind === "inbox" && followsSent(patch)) {
        throw new ValidationError(
          `webhook ${id} is an inbox webhook, which follows no products or projects: leave products and projects out, or create a webhook with kind activity for their events`,
        );
      }
      const follows = followsSent(patch)
        ? webhookFollows(actor, patch)
        : undefined;
      const followsNothing =
        follows !== undefined &&
        (follows.productIds?.length ?? current.products.length) === 0 &&
        (follows.projectIds?.length ?? current.projects.length) === 0;
      if (followsNothing) {
        throw new ValidationError(
          "an activity webhook follows at least one product or project: send products with product keys (like TRL) or projects with project slugs (like launch-q4), or delete the webhook",
        );
      }
      const url =
        patch.url === undefined
          ? undefined
          : (await checkedUrl(patch.url)).url.href;
      return db.transaction(
        (tx) => {
          // again under the write lock: a delete during the DNS lookup is a 404, not an FK failure
          const { url: currentUrl } = ownWebhook(actor, id, tx).view;
          if (url !== undefined && url !== currentUrl) {
            const twin = tx
              .select({ id: webhookSubscription.id })
              .from(webhookSubscription)
              .where(
                and(
                  eq(webhookSubscription.actorId, actor.id),
                  eq(webhookSubscription.url, url),
                ),
              )
              .get();
            if (twin) {
              throw twinConflict(
                actor,
                twin.id,
                tx,
                "use a different URL, or delete that webhook",
              );
            }
          }
          if (url !== undefined) {
            tx.update(webhookSubscription)
              .set({ url })
              .where(eq(webhookSubscription.id, id))
              .run();
          }
          if (follows !== undefined) setFollows(tx, id, follows);
          resume(tx, id, webhooks.now());
          tx.update(webhookSubscription)
            .set({ updatedAt: new Date(), ...managingKey(actor) })
            .where(eq(webhookSubscription.id, id))
            .run();
          return {
            ...ownWebhook(actor, id, tx).view,
            productAlias: follows?.productAlias ?? false,
          };
        },
        { behavior: "immediate" },
      );
    },

    /** Replaces the signing secret; the old one stops signing at once. Ends a pause. */
    rotateWebhookSecret(
      actor: ActingActor,
      id: string,
      secret: string,
    ): Webhook {
      requireBot(actor, "rotate a webhook's secret");
      requireWebhookAction(actor, id, "rotate a webhook's secret");
      validSecret(secret);
      return db.transaction(
        (tx) => {
          tx.update(webhookSubscription)
            .set({
              secretCipher: sealSecret(webhooks.key, id, secret),
              updatedAt: new Date(),
              ...managingKey(actor),
            })
            .where(eq(webhookSubscription.id, id))
            .run();
          resume(tx, id, webhooks.now());
          return ownWebhook(actor, id, tx).view;
        },
        { behavior: "immediate" },
      );
    },

    /** Deletes the subscription with its queued deliveries. */
    deleteWebhook(actor: ActingActor, id: string): { deleted: true } {
      requireBot(actor, "delete a webhook");
      requireWebhookAction(actor, id, "delete a webhook");
      db.delete(webhookSubscription)
        .where(eq(webhookSubscription.id, id))
        .run();
      return { deleted: true };
    },

    /** Sends a signed trail.ping to the subscription now and reports what the receiver answered. */
    async testWebhook(
      actor: ActingActor,
      id: string,
    ): Promise<WebhookTestResult> {
      requireBot(actor, "test a webhook");
      const { view, cipher } = requireWebhookAction(
        actor,
        id,
        "test a webhook",
      );
      const wait = pings.take(id);
      if (wait !== null) {
        throw new RateLimitedError(
          `webhook ${id} was tested ${PING_LIMIT} times in the last ${PING_WINDOW_MS / 1000} seconds, the most allowed: try again in ${wait} seconds`,
          wait,
        );
      }
      const secret = openSecret(webhooks.key, id, cipher);
      if (secret === null) {
        return {
          delivered: false,
          status: null,
          error:
            "trail can no longer read this webhook's secret: set a new one with rotate_webhook_secret",
        };
      }
      const now = webhooks.now();
      const body = JSON.stringify({
        type: "trail.ping",
        occurredAt: new Date(now).toISOString(),
        data: {
          webhookId: id,
          products: view.products,
          projects: view.projects,
          ...(webhooks.publicUrl !== undefined && { url: webhooks.publicUrl }),
          message: "A test call from trail: your webhook is set up.",
        },
      });
      const result = await sendWebhook(
        webhooks,
        { url: view.url, secret, deliveryId: newId(), body },
        webhooks.signal,
      );
      if (webhooks.signal?.aborted) {
        return {
          delivered: false,
          status: null,
          error: "trail is shutting down: test again in a minute",
        };
      }
      return result.ok
        ? { delivered: true, status: result.status, error: null }
        : { delivered: false, status: result.status, error: result.error };
    },

    ...messaging,
  };
}

export type Service = ReturnType<typeof createService>;
