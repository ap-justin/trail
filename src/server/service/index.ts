import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  lt,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.js";
import { newId } from "../db/id.js";
import type { ApiKeyAction } from "../db/schema.js";
import {
  activityEvent,
  actorPhoto,
  actor as actorTable,
  comment,
  type IssueStatus,
  issue,
  issueLabel,
  issueLink,
  label,
  type ProjectHealth,
  project,
  projectStatusUpdate,
  webhookSubscription,
} from "../db/schema.js";
import type { ActivityEvent, EventBus } from "../events/bus.js";
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
  type NormalComment,
  type NormalImport,
  type NormalIssue,
  normalImport,
  zeroCounts,
} from "./import.js";
import { type Actor, andList, type KeyScope } from "./keys.js";
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
  type Link,
  type LinkInput,
  labelKey,
  nonBlank,
  optionalRef,
  validBotTitle,
  validEstimate,
  validHealth,
  validLabelNames,
  validLinks,
  validPriority,
  validProjectKey,
  validStatus,
  withinIssueCap,
} from "./validate.js";
import {
  amongVisible,
  noIssue,
  noProject,
  type VisibleIds,
} from "./visible.js";
import {
  countOwn,
  createPingLimiter,
  enqueueDeliveries,
  insertSubscription,
  PING_LIMIT,
  PING_WINDOW_MS,
  resume,
  setProjects,
  validSecret,
  WEBHOOK_PROJECTS_MAX,
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
export type { Actor } from "./keys.js";
export type { Page, PageQuery } from "./paging.js";
export type { Link, LinkInput } from "./validate.js";

/**
 * Who a call acts as. A bot key's `scope` limits what it reaches; a person
 * carries none, and /api/web applies their visibility before calling.
 */
export type ActingActor = Pick<Actor, "id" | "kind"> & { scope?: KeyScope };
/** An actor with the URL of its photo, null without one. */
export type ActorWithPhoto = Actor & { photoUrl: string | null };
export type Project = typeof project.$inferSelect;
type IssueRow = typeof issue.$inferSelect;
/** An issue with its key (as in TRL-12), label names A–Z, and links in the order set. */
export type Issue = IssueRow & { key: string; labels: string[]; links: Link[] };
export type Comment = typeof comment.$inferSelect;
export type Label = typeof label.$inferSelect;
export type StatusUpdate = typeof projectStatusUpdate.$inferSelect;

/** Every create takes these; a repeat with the same key returns the first result. */
export type WriteOptions = { idempotencyKey?: string };

export type ProjectInput = {
  name: string;
  key: string;
  description?: string;
  externalRef?: string | null;
};
export type ProjectPatch = { name?: string; description?: string };
/** `projectId` takes the project's id or key. */
export type IssueInput = {
  projectId: string;
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
  title?: string;
  description?: string;
  status?: IssueStatus;
  /** null unassigns */
  assigneeId?: string | null;
  /** null clears */
  estimate?: number | null;
  priority?: number;
  /** replaces the issue's labels */
  labels?: string[];
  /** replaces the issue's links */
  links?: LinkInput[];
  /** added to the issue's labels; refused beside `labels` */
  addLabels?: string[];
  /** removed from the issue's labels, matched ignoring the case of A-Z; refused beside `labels` */
  removeLabels?: string[];
  /** added to the issue's links, a url already there taking the new title; refused beside `links` */
  addLinks?: LinkInput[];
  /** urls of links to remove; refused beside `links` */
  removeLinks?: string[];
};
export type CommentInput = {
  issueId: string;
  body: string;
  externalRef?: string | null;
};
export type StatusUpdateInput = {
  projectId: string;
  body: string;
  health: ProjectHealth;
  externalRef?: string | null;
};
export type LabelInput = { projectId: string; name: string };
/** An imported issue that could not keep its source key's number and took the project's next one. */
export type Renumbered = {
  externalRef: string;
  sourceKey: string | null;
  key: string;
};
export type ImportResult = {
  project: Project;
  renumbered: Renumbered[];
  created: ImportCounts;
  updated: ImportCounts;
  unchanged: ImportCounts;
};
export type IssueQuery = PageQuery & {
  projectId?: string;
  status?: IssueStatus;
  assigneeId?: string;
};
/**
 * `cursor` pages newest first; `after` resumes oldest first from a cursor ("" is
 * the start of the feed), and its page always carries a cursor to resume from.
 */
export type ActivityQuery = PageQuery & {
  after?: string;
  projectId?: string;
  actorId?: string;
};

type NewEvent = Omit<typeof activityEvent.$inferInsert, "id" | "createdAt">;
type Change = { from: unknown; to: unknown };
type Write<T> = { result: T; event: NewEvent | null };

// a project key, a dash and the issue's number: TRL-12
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

/** "project A" or "projects A and B": the projects a key is limited to. */
const reachOf = (projects: { key: string }[]) =>
  `project${projects.length > 1 ? "s" : ""} ${andList(projects.map((p) => p.key))}`;

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

const visibleIdsOf = (actor: ActingActor): VisibleIds =>
  actor.scope?.projects?.map((p) => p.id) ?? null;

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
}: {
  db: Db;
  bus: EventBus;
  webhooks: WebhookSettings;
}) {
  const pings = createPingLimiter(() => webhooks.now());

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

  /** Project keys or ids as the project ids a webhook follows; one the key can't see is a 404, as everywhere. */
  function webhookProjectIds(actor: ActingActor, refs: string[]): string[] {
    if (refs.length === 0) {
      throw new ValidationError(
        "projects must name at least one project: send the keys (like TRL) of the projects whose events you want",
      );
    }
    if (refs.length > WEBHOOK_PROJECTS_MAX) {
      throw new ValidationError(
        `projects names ${refs.length} projects, over the limit of ${WEBHOOK_PROJECTS_MAX}`,
      );
    }
    return [...new Set(refs.map((ref) => resolveProject(db, ref, actor).id))];
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

  /** True when every project the webhook follows is within the key's scope. */
  function withinScope(actor: ActingActor, hook: Webhook): boolean {
    const scoped = actor.scope?.projects;
    if (scoped == null) return true;
    return hook.projects.every((key) => scoped.some((p) => p.key === key));
  }

  /** The 409 for a URL the bot already uses: names the webhook only when this key can manage it. */
  function twinConflict(
    actor: ActingActor,
    twinId: string,
    from: Db | Tx,
    advice: string,
  ) {
    try {
      ownWebhook(actor, twinId, from);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      return new ConflictError(
        "this bot already has a webhook to that URL that this key can't manage: use a different URL, or ask for a key that reaches that webhook's projects",
      );
    }
    return new ConflictError(
      `webhook ${twinId} already sends to this URL: ${advice}`,
    );
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
    const { result, event } = db.transaction(
      (tx) => {
        const { result, event } = write(tx);
        if (!event) return { result, event: null };
        const committed = tx
          .insert(activityEvent)
          .values(event)
          .returning()
          .get();
        enqueueDeliveries(tx, committed, webhooks.now());
        return { result, event: committed };
      },
      { behavior: "immediate" },
    );
    if (event) bus.publish(event);
    return result;
  }

  /**
   * `commit` for a create. `prepare` resolves the input inside the transaction
   * and returns it normalised as `request`, which an idempotency key is checked
   * against before `write` runs; a replay writes nothing and returns the first
   * result.
   */
  function create<T>(
    actor: ActingActor,
    options: WriteOptions,
    scope: string,
    prepare: (tx: Tx) => { request: unknown; write: () => Write<T> },
  ): T {
    const key =
      options.idempotencyKey === undefined
        ? undefined
        : validIdempotencyKey(options.idempotencyKey);
    return commit((tx) => {
      const { request, write } = prepare(tx);
      if (key === undefined) return write();
      const idem: IdempotentRequest = { key, scope, request };
      const replay = replayOf<T>(tx, actor.id, idem);
      if (replay !== undefined) return { result: replay, event: null };
      const written = write();
      storeResult(tx, actor.id, idem, written.result);
      return written;
    });
  }

  /** The project the actor sees with this id, or else this key (in any case). */
  function resolveProject(
    tx: Tx | Db,
    ref: string,
    actor: ActingActor,
  ): Project {
    const visible = amongVisible(project.id, visibleIdsOf(actor));
    const found =
      tx
        .select()
        .from(project)
        .where(and(eq(project.id, ref), visible))
        .get() ??
      tx
        .select()
        .from(project)
        .where(and(eq(project.key, ref.toUpperCase()), visible))
        .get();
    if (!found) {
      throw noProject(
        ref,
        "pass the id or key (like TRL) of an existing project",
      );
    }
    return found;
  }

  /**
   * The issue the actor sees with this id, else this key (TRL-12, the project
   * key in any case), else this source key (JUS-187, any case): a trail key
   * wins over a source key that looks the same. Only visible issues are
   * searched, so a hidden one shadows nothing.
   */
  function resolveIssueRow(
    tx: Tx | Db,
    ref: string,
    actor: ActingActor,
  ): IssueRow {
    const visible = amongVisible(issue.projectId, visibleIdsOf(actor));
    const byId = tx
      .select()
      .from(issue)
      .where(and(eq(issue.id, ref), visible))
      .get();
    if (byId) return byId;
    const match = issueKeyPattern.exec(ref);
    const byKey =
      match &&
      tx
        .select({ issue })
        .from(issue)
        .innerJoin(project, eq(project.id, issue.projectId))
        .where(
          and(
            eq(project.key, (match[1] as string).toUpperCase()),
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
    if (!bySourceKey) {
      throw noIssue(
        ref,
        "pass the id, the key (like TRL-12) or the source key (like JUS-187, kept from an import) of an existing issue",
      );
    }
    return bySourceKey;
  }

  /** Each row with its key, labels and links, in the order given. */
  function hydrate(tx: Tx | Db, rows: IssueRow[]): Issue[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const keys = new Map(
      tx
        .select({ id: project.id, key: project.key })
        .from(project)
        .where(inArray(project.id, [...new Set(rows.map((r) => r.projectId))]))
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
    return rows.map((row) => ({
      ...row,
      key: `${keys.get(row.projectId)}-${row.number}`,
      labels: labels.filter((l) => l.issueId === row.id).map((l) => l.name),
      links: links
        .filter((l) => l.issueId === row.id)
        .map(({ url, title }) => ({ url, title })),
    }));
  }

  const hydrateOne = (tx: Tx | Db, row: IssueRow) =>
    hydrate(tx, [row])[0] as Issue;

  // an unknown assignee is a bad field in the body, not a missing target
  function requireAssignee(tx: Tx, id: string | null | undefined): void {
    if (id == null) return;
    const found = tx
      .select({ id: actorTable.id })
      .from(actorTable)
      .where(eq(actorTable.id, id))
      .get();
    if (!found) throw new ValidationError(`no actor ${id} to assign`);
  }

  function findLabel(tx: Tx, projectId: string, name: string) {
    return tx
      .select()
      .from(label)
      .where(
        and(
          eq(label.projectId, projectId),
          sql`${label.name} = ${name} collate nocase`,
        ),
      )
      .get();
  }

  /** The project's labels by these names, matched ignoring the case of A-Z, created when missing. */
  function labelsNamed(tx: Tx, projectId: string, names: string[]): Label[] {
    return names.map(
      (name) =>
        findLabel(tx, projectId, name) ??
        tx.insert(label).values({ projectId, name }).returning().get(),
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
          projectId: target.projectId,
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

  /** The project's next issue number, handed out in this transaction. */
  function nextIssueNumber(tx: Tx, projectId: string): number {
    const { issueSeq } = tx
      .update(project)
      .set({
        issueSeq: sql`${project.issueSeq} + 1`,
        // numbering an issue is not an edit to the project
        updatedAt: sql`${project.updatedAt}`,
      })
      .where(eq(project.id, projectId))
      .returning({ issueSeq: project.issueSeq })
      .get() as { issueSeq: number };
    return issueSeq;
  }

  /**
   * The numbers of the issues an import creates, by externalRef. One whose
   * sourceKey, or with none its externalRef, is in the project's own key form
   * (JUS-187) keeps that number, so its key still resolves; the project's
   * sequence moves up to the highest kept, then numbers the rest after it by
   * (createdAt, externalRef), whatever the payload order. One whose number
   * another issue already holds is numbered with the rest and listed in
   * `renumbered` with its new key; its source key is the holder's key, which
   * `resolveIssueRow` matches first, so it resolves to the holder.
   */
  function importNumbers(
    tx: Tx,
    target: Project,
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
        .where(and(eq(issue.projectId, target.id), eq(issue.number, number)))
        .get();
      if (holder) {
        taken.add(row.externalRef);
        sequenced.push(row);
        continue;
      }
      numbers.set(row.externalRef, number);
    }
    if (numbers.size > 0) {
      tx.update(project)
        .set({
          issueSeq: sql`max(${project.issueSeq}, ${Math.max(...numbers.values())})`,
          updatedAt: sql`${project.updatedAt}`,
        })
        .where(eq(project.id, target.id))
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

  /** The project with the payload's externalRef, created or brought up to date. */
  function importProjectRow(
    tx: Tx,
    actor: ActingActor,
    input: NormalImport,
    tally: Tally,
  ): Project {
    const existing = tx
      .select()
      .from(project)
      .where(eq(project.externalRef, input.externalRef))
      .get();
    // before any key is checked for a clash, so a hidden project and a new one are refused alike
    const limited = actor.scope?.projects;
    if (limited && !limited.some((p) => p.id === existing?.id)) {
      throw new ForbiddenScopeError(
        `this key may not import a project outside ${reachOf(limited)}. Ask whoever minted the key for one that lists the project, or no project list.`,
      );
    }
    if (!existing) {
      const taken = tx
        .select()
        .from(project)
        .where(eq(project.key, input.key))
        .get();
      if (taken) {
        throw new ConflictError(
          `project key ${input.key} is taken by project ${taken.id} ("${taken.name}", externalRef ${taken.externalRef ?? "none"}): send another key for ${input.externalRef}`,
        );
      }
      tally.created.projects++;
      return tx
        .insert(project)
        .values({
          externalRef: input.externalRef,
          key: input.key,
          name: input.name,
          description: input.description ?? "",
          createdAt: input.createdAt,
          createdBy: actor.id,
        })
        .returning()
        .get();
    }
    if (existing.key !== input.key) {
      throw new ConflictError(
        `project ${input.externalRef} was imported with key ${existing.key}: send key ${existing.key}, since a project's key never changes`,
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
      .update(project)
      .set(changed)
      .where(eq(project.id, existing.id))
      .returning()
      .get() as Project;
  }

  /** The project's labels by `labelKey`: each payload name created when missing, renamed when only its case differs. */
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
        found = tx.insert(label).values({ projectId, name }).returning().get();
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
    target: Project,
    row: NormalIssue,
    current: Issue | undefined,
    /** From `importNumbers`, for a row with no `current`. */
    number: number | undefined,
    labels: Map<string, Label>,
    tally: Tally,
    now: Date,
  ): string {
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
        const visible = visibleIdsOf(actor);
        // source keys are unique across projects, so the 409 itself still tells a scoped key the
        // key is taken somewhere; only a holder the key can see is named
        const who =
          visible === null || visible.includes(holder.projectId)
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
          projectId: target.id,
          number: number as number,
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
        .from(projectStatusUpdate)
        .where(
          and(
            eq(projectStatusUpdate.projectId, projectId),
            isNotNull(projectStatusUpdate.externalRef),
          ),
        )
        .all()
        .map((u) => [u.externalRef, u]),
    );
    for (const row of rows) {
      const current = existing.get(row.externalRef);
      if (!current) {
        tx.insert(projectStatusUpdate)
          .values({
            projectId,
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
      tx.update(projectStatusUpdate)
        .set(changed)
        .where(eq(projectStatusUpdate.id, current.id))
        .run();
      tally.updated.statusUpdates++;
    }
  }

  const sortedNames = (labels: Label[]) =>
    labels.map((l) => l.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    createProject(
      actor: ActingActor,
      input: ProjectInput,
      options: WriteOptions = {},
    ): Project {
      requireBot(actor, "create a project");
      requireAction(actor, "admin", "create a project");
      const limited = actor.scope?.projects;
      // before the key is checked, so a taken key in a hidden project tells it nothing
      if (limited) {
        throw new ForbiddenScopeError(
          `this key may not create a project: it reaches only ${reachOf(limited)}. Ask whoever minted the key for one with no project list.`,
        );
      }
      const fields = {
        name: nonBlank(input.name, "name"),
        key: validProjectKey(input.key),
        description: input.description ?? "",
        externalRef: optionalRef(input.externalRef),
      };
      return create(actor, options, "project.create", (tx) => ({
        request: fields,
        write: () => {
          const taken = tx
            .select()
            .from(project)
            .where(eq(project.key, fields.key))
            .get();
          if (taken) {
            throw new ConflictError(
              `project key ${fields.key} is taken by project ${taken.id} ("${taken.name}"): choose another key`,
            );
          }
          if (fields.externalRef !== null) {
            const twin = tx
              .select()
              .from(project)
              .where(eq(project.externalRef, fields.externalRef))
              .get();
            if (twin) {
              throw new ConflictError(
                `externalRef ${fields.externalRef} is already on project ${twin.key} (${twin.id}): use that project, or send a different externalRef`,
              );
            }
          }
          const created = tx
            .insert(project)
            .values({ ...fields, createdBy: actor.id })
            .returning()
            .get();
          return {
            result: created,
            event: {
              actorId: actor.id,
              subjectType: "project",
              subjectId: created.id,
              projectId: created.id,
              action: "project.created",
              payload: {
                name: created.name,
                key: created.key,
                description: created.description,
                externalRef: created.externalRef,
              },
            },
          };
        },
      }));
    },

    /** A patch that changes nothing writes nothing and emits no event. */
    updateProject(
      actor: ActingActor,
      ref: string,
      patch: ProjectPatch,
    ): Project {
      requireBot(actor, "update a project");
      requireAction(actor, "admin", "update a project", () =>
        resolveProject(db, ref, actor),
      );
      const next: ProjectPatch = {
        name:
          patch.name === undefined ? undefined : nonBlank(patch.name, "name"),
        description: patch.description,
      };
      return commit((tx) => {
        const current = resolveProject(tx, ref, actor);
        const changes = changesOf(current, next);
        if (Object.keys(changes).length === 0) {
          return { result: current, event: null };
        }
        const updated = tx
          .update(project)
          .set(next)
          .where(eq(project.id, current.id))
          .returning()
          .get() as Project;
        return {
          result: updated,
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

    /** A human files an issue unassigned: an assignee from a human is refused. */
    createIssue(
      actor: ActingActor,
      input: IssueInput,
      options: WriteOptions = {},
    ): Issue {
      requireAction(actor, "issues", "create an issue", () =>
        resolveProject(db, input.projectId, actor),
      );
      if (actor.kind === "human" && input.assigneeId != null) {
        throw new ForbiddenError(
          "a human files an issue unassigned: drop assigneeId, and a bot assigns it",
        );
      }
      const title = nonBlank(input.title, "title");
      const priority = validPriority(input.priority);
      const estimate = validEstimate(input.estimate);
      const labelNames = validLabelNames(input.labels ?? []);
      const links = validLinks(input.links ?? []);
      const externalRef = optionalRef(input.externalRef);
      return create(actor, options, "issue.create", (tx) => {
        const target = resolveProject(tx, input.projectId, actor);
        requireAssignee(tx, input.assigneeId);
        const fields = {
          projectId: target.id,
          title,
          description: input.description ?? "",
          assigneeId: input.assigneeId ?? null,
          estimate: estimate ?? null,
          priority: priority ?? 0,
          externalRef,
        };
        return {
          request: { ...fields, labels: labelNames, links },
          write: () => {
            if (externalRef !== null) {
              const twin = tx
                .select({ id: issue.id, number: issue.number })
                .from(issue)
                .where(
                  and(
                    eq(issue.projectId, target.id),
                    eq(issue.externalRef, externalRef),
                  ),
                )
                .get();
              if (twin) {
                throw new ConflictError(
                  `externalRef ${externalRef} is already on issue ${target.key}-${twin.number} (${twin.id}): update that issue, or send a different externalRef`,
                );
              }
            }
            const row = tx
              .insert(issue)
              .values({
                ...fields,
                number: nextIssueNumber(tx, target.id),
                createdBy: actor.id,
              })
              .returning()
              .get();
            setLabels(tx, row, labelsNamed(tx, target.id, labelNames));
            setLinks(tx, row.id, links);
            const created = hydrateOne(tx, row);
            return {
              result: created,
              event: {
                actorId: actor.id,
                subjectType: "issue",
                subjectId: created.id,
                projectId: created.projectId,
                action: "issue.created",
                payload: {
                  key: created.key,
                  title: created.title,
                  description: created.description,
                  status: created.status,
                  assigneeId: created.assigneeId,
                  estimate: created.estimate,
                  priority: created.priority,
                  labels: created.labels,
                  links: created.links,
                  externalRef: created.externalRef,
                },
              },
            };
          },
        };
      });
    },

    /** A patch that changes nothing writes nothing and emits no event. */
    updateIssue(actor: ActingActor, ref: string, patch: IssuePatch): Issue {
      requireBot(actor, "update an issue");
      requireAction(actor, "issues", "update an issue", () =>
        resolveIssueRow(db, ref, actor),
      );
      const next = {
        title:
          patch.title === undefined
            ? undefined
            : nonBlank(patch.title, "title"),
        description: patch.description,
        status:
          patch.status === undefined ? undefined : validStatus(patch.status),
        assigneeId: patch.assigneeId,
        estimate: validEstimate(patch.estimate),
        priority: validPriority(patch.priority),
      };
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
      const labelNames =
        patch.labels === undefined ? undefined : validLabelNames(patch.labels);
      const replacementLinks =
        patch.links === undefined ? undefined : validLinks(patch.links);
      return commit((tx) => {
        const row = resolveIssueRow(tx, ref, actor);
        const current = hydrateOne(tx, row);
        const changes = changesOf<IssueRow>(row, next);
        if ("assigneeId" in changes) requireAssignee(tx, next.assigneeId);
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
        if (wantedLabels !== undefined) {
          labels = labelsNamed(tx, row.projectId, wantedLabels);
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
        if (Object.keys(changes).length === 0) {
          return { result: current, event: null };
        }
        const now = new Date();
        const updatedRow = tx
          .update(issue)
          .set({
            ...next,
            completedAt: completedAtOf(
              next.status ?? row.status,
              row.completedAt,
              now,
            ),
            updatedAt: now,
          })
          .where(eq(issue.id, row.id))
          .returning()
          .get() as IssueRow;
        if (labels && "labels" in changes) setLabels(tx, row, labels);
        if (links && "links" in changes) setLinks(tx, row.id, links);
        return {
          result: hydrateOne(tx, updatedRow),
          event: {
            actorId: actor.id,
            subjectType: "issue",
            subjectId: row.id,
            projectId: row.projectId,
            action: "issue.updated",
            payload: changes,
          },
        };
      });
    },

    addComment(
      actor: ActingActor,
      input: CommentInput,
      options: WriteOptions = {},
    ): Comment {
      requireAction(actor, "comments", "comment on an issue", () =>
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
                  `externalRef ${externalRef} is already on comment ${twin.id} of this issue: it is posted already, or send a different externalRef`,
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
                projectId: target.projectId,
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

    createStatusUpdate(
      actor: ActingActor,
      input: StatusUpdateInput,
      options: WriteOptions = {},
    ): StatusUpdate {
      requireBot(actor, "post a project status update");
      requireAction(actor, "status_updates", "post a status update", () =>
        resolveProject(db, input.projectId, actor),
      );
      const body = input.body;
      if (body.trim() === "") {
        throw new ValidationError("body must not be empty");
      }
      const health = validHealth(input.health);
      const externalRef = optionalRef(input.externalRef);
      return create(actor, options, "status_update.create", (tx) => {
        const target = resolveProject(tx, input.projectId, actor);
        const fields = { projectId: target.id, body, health, externalRef };
        return {
          request: fields,
          write: () => {
            if (externalRef !== null) {
              const twin = tx
                .select({ id: projectStatusUpdate.id })
                .from(projectStatusUpdate)
                .where(
                  and(
                    eq(projectStatusUpdate.projectId, target.id),
                    eq(projectStatusUpdate.externalRef, externalRef),
                  ),
                )
                .get();
              if (twin) {
                throw new ConflictError(
                  `externalRef ${externalRef} is already on status update ${twin.id} of project ${target.key}: it is posted already, or send a different externalRef`,
                );
              }
            }
            const created = tx
              .insert(projectStatusUpdate)
              .values({ ...fields, authorId: actor.id })
              .returning()
              .get();
            return {
              result: created,
              event: {
                actorId: actor.id,
                subjectType: "status_update",
                subjectId: created.id,
                projectId: target.id,
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
        resolveProject(db, input.projectId, actor),
      );
      const name = nonBlank(input.name, "name");
      return create(actor, options, "label.create", (tx) => {
        const target = resolveProject(tx, input.projectId, actor);
        return {
          request: { projectId: target.id, name },
          write: () => {
            const twin = findLabel(tx, target.id, name);
            if (twin) {
              throw new ConflictError(
                `project ${target.key} already has the label "${twin.name}": use it as it is, since label names match ignoring the case of A-Z`,
              );
            }
            const created = tx
              .insert(label)
              .values({ projectId: target.id, name })
              .returning()
              .get();
            return {
              result: created,
              event: {
                actorId: actor.id,
                subjectType: "label",
                subjectId: created.id,
                projectId: target.id,
                action: "label.created",
                payload: { name },
              },
            };
          },
        };
      });
    },

    /**
     * Upserts a project and its rows by externalRef in one transaction: a new
     * row is created, a changed one updated, an identical one left untouched
     * (updatedAt included), and nothing missing from the payload is deleted.
     * One project.imported event carries the counts; a run that changes
     * nothing writes none.
     */
    importProject(actor: ActingActor, payload: ImportPayload): ImportResult {
      requireBot(actor, "import a project");
      requireAction(actor, "admin", "import a project");
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
                  eq(issue.projectId, target.id),
                  isNotNull(issue.externalRef),
                ),
              )
              .all(),
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
          project: tx
            .select()
            .from(project)
            .where(eq(project.id, target.id))
            .get() as Project,
          renumbered,
          ...tally,
        };
        const wrote = [tally.created, tally.updated].some((counts) =>
          Object.values(counts).some((n) => n > 0),
        );
        if (!wrote) return { result, event: null };
        return {
          result,
          event: {
            actorId: actor.id,
            subjectType: "project",
            subjectId: target.id,
            projectId: target.id,
            action: "project.imported",
            payload: { externalRef: target.externalRef, ...tally, renumbered },
          },
        };
      });
    },

    getProject(actor: ActingActor, ref: string): Project {
      requireAction(actor, "read", "read a project", () =>
        resolveProject(db, ref, actor),
      );
      return resolveProject(db, ref, actor);
    },

    /** Newest first. */
    listProjects(actor: ActingActor, query: PageQuery = {}): Page<Project> {
      requireAction(actor, "read", "list projects");
      const visible = [amongVisible(project.id, visibleIdsOf(actor))];
      return page(project, "desc", query, visible, (where, orderBy, limit) =>
        db
          .select()
          .from(project)
          .where(where)
          .orderBy(...orderBy)
          .limit(limit)
          .all(),
      );
    },

    getIssue(actor: ActingActor, ref: string): Issue {
      requireAction(actor, "read", "read an issue", () =>
        resolveIssueRow(db, ref, actor),
      );
      return hydrateOne(db, resolveIssueRow(db, ref, actor));
    },

    /** Newest first. */
    listIssues(actor: ActingActor, query: IssueQuery = {}): Page<Issue> {
      requireAction(actor, "read", "list issues", () =>
        query.projectId === undefined
          ? undefined
          : resolveProject(db, query.projectId, actor),
      );
      const filters = [
        amongVisible(issue.projectId, visibleIdsOf(actor)),
        query.projectId === undefined
          ? undefined
          : eq(issue.projectId, resolveProject(db, query.projectId, actor).id),
        query.status === undefined
          ? undefined
          : eq(issue.status, validStatus(query.status)),
        query.assigneeId === undefined
          ? undefined
          : eq(issue.assigneeId, query.assigneeId),
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
      return { items: hydrate(db, rows.items), nextCursor: rows.nextCursor };
    },

    /** Oldest first, the order an issue's thread reads in. */
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

    /** Newest first. */
    listStatusUpdates(
      actor: ActingActor,
      projectRef: string,
      query: PageQuery = {},
    ): Page<StatusUpdate> {
      requireAction(actor, "read", "list status updates", () =>
        resolveProject(db, projectRef, actor),
      );
      const target = resolveProject(db, projectRef, actor);
      return page(
        projectStatusUpdate,
        "desc",
        query,
        [eq(projectStatusUpdate.projectId, target.id)],
        (where, orderBy, limit) =>
          db
            .select()
            .from(projectStatusUpdate)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
    },

    /** Oldest first. */
    listLabels(
      actor: ActingActor,
      projectRef: string,
      query: PageQuery = {},
    ): Page<Label> {
      requireAction(actor, "read", "list labels", () =>
        resolveProject(db, projectRef, actor),
      );
      const target = resolveProject(db, projectRef, actor);
      return page(
        label,
        "asc",
        query,
        [eq(label.projectId, target.id)],
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

    /** The calling actor, as stored, with its photo URL; actors are never deleted, so the row is there. */
    whoami(actor: ActingActor): ActorWithPhoto {
      return withPhotoUrl(
        selectWithPhotoHash()
          .where(eq(actorTable.id, actor.id))
          .get() as ActorWithHash,
      );
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

    /** Sets the calling bot's title, trimmed, and publishes it when it changed. Any key may. */
    setMyTitle(actor: ActingActor, raw: string): { title: string } {
      const title = validBotTitle(raw);
      setTitle(actor.id, title);
      return { title };
    },

    /** Clears the calling bot's title, publishing the removal when it had one. Any key may. */
    clearMyTitle(actor: ActingActor): { title: null } {
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
    ): Page<ActivityEvent> {
      requireAction(actor, "read", "read the activity feed", () =>
        query.projectId === undefined
          ? undefined
          : resolveProject(db, query.projectId, actor),
      );
      if (query.cursor !== undefined && query.after !== undefined) {
        throw new ValidationError(
          "send cursor (newest first) or after (oldest first), not both",
        );
      }
      const limit = pageLimit(query.limit);
      const filters: FeedFilters = {
        projectId:
          query.projectId === undefined
            ? null
            : resolveProject(db, query.projectId, actor).id,
        actorId: query.actorId ?? null,
      };
      const where: (SQL | undefined)[] = [
        amongVisible(activityEvent.projectId, visibleIdsOf(actor)),
        filters.projectId === null
          ? undefined
          : eq(activityEvent.projectId, filters.projectId),
        filters.actorId === null
          ? undefined
          : eq(activityEvent.actorId, filters.actorId),
      ];
      const select = (order: SQL, max: number) =>
        db
          .select()
          .from(activityEvent)
          .where(and(...where))
          .orderBy(order)
          .limit(max)
          .all();

      if (query.after !== undefined) {
        const from =
          query.after === ""
            ? 0
            : decodeFeedCursor(query.after, filters, "after");
        where.push(gt(activityEvent.seq, from));
        const items = select(asc(activityEvent.seq), limit);
        const seq = items.at(-1)?.seq ?? from;
        return {
          items,
          nextCursor: encodeFeedCursor({ ...filters, seq, param: "after" }),
        };
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
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? encodeFeedCursor({ ...filters, seq: last.seq, param: "cursor" })
            : null,
      };
    },

    // Webhooks. A subscription belongs to the bot, so every call below names only the
    // calling bot's own; one that follows a project outside the key's scope is as
    // missing to that key as a project it can't see.

    async createWebhook(
      actor: ActingActor,
      input: { url: string; secret: string; projects: string[] },
    ): Promise<Webhook> {
      requireBot(actor, "subscribe to a project");
      requireAction(actor, "read", "create a webhook");
      validSecret(input.secret);
      const projectIds = webhookProjectIds(actor, input.projects);
      const refuseAtLimit = (from: Db | Tx) => {
        const count = countOwn(from, actor.id);
        if (count >= WEBHOOKS_PER_BOT_MAX) {
          // a count or advice about webhooks this key can't see would describe them
          const own = from
            .select()
            .from(webhookSubscription)
            .where(eq(webhookSubscription.actorId, actor.id))
            .all();
          if (!webhooksOf(from, own).every((w) => withinScope(actor, w))) {
            throw new ConflictError(
              `this bot has reached its limit of ${WEBHOOKS_PER_BOT_MAX} webhooks, and this key can't manage all of them: a key that reaches every project the bot follows can delete one to make room`,
            );
          }
          throw new ConflictError(
            `this bot already has ${count} webhooks, the most allowed: delete one you no longer use, or add the project to one you have with update_webhook`,
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
            actorId: actor.id,
            url: url.href,
            secret: input.secret,
            projectIds,
          });
          return webhooksOf(tx, [row])[0] as Webhook;
        },
        { behavior: "immediate" },
      );
    },

    listWebhooks(actor: ActingActor): Page<Webhook> {
      requireBot(actor, "list webhooks");
      requireAction(actor, "read", "list webhooks");
      const rows = db
        .select()
        .from(webhookSubscription)
        .where(eq(webhookSubscription.actorId, actor.id))
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
      requireAction(actor, "read", "read a webhook", () =>
        ownWebhook(actor, id),
      );
      return ownWebhook(actor, id).view;
    },

    /** Changes the URL or the followed projects; any update, an empty one too, ends a pause. */
    async updateWebhook(
      actor: ActingActor,
      id: string,
      patch: { url?: string; projects?: string[] },
    ): Promise<Webhook> {
      requireBot(actor, "update a webhook");
      requireAction(actor, "read", "update a webhook", () =>
        ownWebhook(actor, id),
      );
      ownWebhook(actor, id);
      const projectIds =
        patch.projects === undefined
          ? undefined
          : webhookProjectIds(actor, patch.projects);
      const url =
        patch.url === undefined
          ? undefined
          : (await checkedUrl(patch.url)).url.href;
      return db.transaction(
        (tx) => {
          // again under the write lock: a delete during the DNS lookup is a 404, not an FK failure
          const current = ownWebhook(actor, id, tx).view;
          if (url !== undefined && url !== current.url) {
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
          if (projectIds !== undefined) setProjects(tx, id, projectIds);
          resume(tx, id, webhooks.now());
          tx.update(webhookSubscription)
            .set({ updatedAt: new Date() })
            .where(eq(webhookSubscription.id, id))
            .run();
          return ownWebhook(actor, id, tx).view;
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
      requireAction(actor, "read", "rotate a webhook's secret", () =>
        ownWebhook(actor, id),
      );
      ownWebhook(actor, id);
      validSecret(secret);
      return db.transaction(
        (tx) => {
          tx.update(webhookSubscription)
            .set({
              secretCipher: sealSecret(webhooks.key, id, secret),
              updatedAt: new Date(),
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
      requireAction(actor, "read", "delete a webhook", () =>
        ownWebhook(actor, id),
      );
      ownWebhook(actor, id);
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
      requireAction(actor, "read", "test a webhook", () =>
        ownWebhook(actor, id),
      );
      const { view, cipher } = ownWebhook(actor, id);
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
  };
}

export type Service = ReturnType<typeof createService>;
