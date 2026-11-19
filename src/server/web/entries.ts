import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import {
  type EntryView,
  type WebActorView,
  type WebItemRefView,
  type WebProductRefView,
  type WebProjectRefView,
  webProjectFields,
} from "../../shared/schemas.js";
import type { Db } from "../db/client.js";
import type { IssueStatus, IssueType } from "../db/schema.js";
import {
  activityEvent,
  comment,
  issue,
  product,
  productStatusUpdate,
  project,
  projectStatusUpdate,
} from "../db/schema.js";
import type { ActivityEvent } from "../events/bus.js";
import { importedEventPayload, type Link } from "../service/index.js";
import { actorsById } from "./visible.js";

type Change<T> = { from: T; to: T };

/** The part of an `issue.updated` payload (field → from/to) the feed shows. */
export type IssueChanges = {
  status?: Change<IssueStatus>;
  type?: Change<IssueType>;
  priority?: Change<number>;
  labels?: Change<string[]>;
  links?: Change<Link[]>;
  assigneeId?: Change<string | null>;
  estimate?: Change<number | null>;
};

/**
 * The type an `issue.created` payload records; one stored before payloads
 * carried it (or an imported item, which has none) reads issue when a person
 * created the item, else the item's type now.
 */
function createdAs(
  createdPayload: unknown,
  creator: WebActorView,
  current: IssueType,
): IssueType {
  const recorded = (createdPayload as { type?: IssueType } | undefined)?.type;
  return recorded ?? (creator.kind === "human" ? "issue" : current);
}

/** A `project.updated` payload's field names, as the entry names them. */
const projectFieldOf: Record<string, (typeof webProjectFields)[number]> = {
  name: "name",
  goal: "goal",
  leadId: "lead",
  targetDate: "targetDate",
};

const shownActions = [
  "product.created",
  "product.imported",
  "issue.created",
  "comment.created",
  "status_update.created",
  "project.created",
  "project.updated",
  "project.item_added",
  "project.item_removed",
];

const changed = (field: string) =>
  sql`json_type(${activityEvent.payload}, ${`$.${field}`}) is not null`;

/**
 * The events that become at least one entry: a page of them is never empty of
 * entries. An `issue.updated` shows only when it changed a field the feed
 * shows; a links change only when it added a url. A `project.updated` always
 * changed a field it shows.
 */
export const shownEvent: SQL = or(
  inArray(activityEvent.action, shownActions),
  and(
    eq(activityEvent.action, "issue.updated"),
    or(
      changed("status"),
      changed("type"),
      changed("priority"),
      changed("labels"),
      changed("assigneeId"),
      changed("estimate"),
      sql`exists (select 1 from json_each(${activityEvent.payload}, '$.links.to') t where t.value ->> 'url' not in (select f.value ->> 'url' from json_each(${activityEvent.payload}, '$.links.from') f))`,
    ),
  ),
) as SQL;

type ItemRef = WebItemRefView & { id: string; sourceAuthor: string | null };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** An entry without what every entry of its event shares. */
type EntryPart = DistributiveOmit<
  EntryView,
  "id" | "createdAt" | "actor" | "product" | "project" | "item"
>;

/** The bits of an item's changes the feed shows, each one entry, in a fixed order. */
function changeEntries(
  changes: IssueChanges,
  actorOf: (id: string) => WebActorView,
): EntryPart[] {
  const parts: EntryPart[] = [];
  // a note has no priority, estimate or assignee: the type change already says they went
  const toNote = changes.type?.to === "note";
  if (changes.status) {
    parts.push({ kind: "status_changed", ...changes.status });
  }
  if (changes.type) {
    parts.push({ kind: "type_changed", ...changes.type });
  }
  if (changes.priority && !toNote) {
    parts.push({ kind: "priority_changed", ...changes.priority });
  }
  if (changes.labels) {
    const { from, to } = changes.labels;
    parts.push({
      kind: "labels_changed",
      added: to.filter((n) => !from.includes(n)),
      removed: from.filter((n) => !to.includes(n)),
    });
  }
  if (changes.links) {
    const before = new Set(changes.links.from.map((l) => l.url));
    for (const link of changes.links.to) {
      if (!before.has(link.url)) {
        parts.push({
          kind: "link_added",
          link: { url: link.url, title: link.title },
        });
      }
    }
  }
  if (changes.assigneeId && !toNote) {
    const { from, to } = changes.assigneeId;
    parts.push({
      kind: "assignee_changed",
      from: from === null ? null : actorOf(from),
      to: to === null ? null : actorOf(to),
    });
  }
  if (changes.estimate && !toNote) {
    parts.push({ kind: "estimate_changed", ...changes.estimate });
  }
  return parts;
}

/** The actor ids an `issue.updated` payload names as assignees. */
const assigneeIds = (event: ActivityEvent) => {
  const change = (event.payload as IssueChanges).assigneeId;
  return change ? [change.from, change.to] : [];
};

/** The rows `load` reads for the subjects of the events `test` picks, by id. */
function rowsFor<T extends { id: string }>(
  events: ActivityEvent[],
  test: (e: ActivityEvent) => boolean,
  load: (ids: string[]) => T[],
): Map<string, T> {
  const ids = events.filter(test).map((e) => e.subjectId);
  return new Map((ids.length === 0 ? [] : load(ids)).map((r) => [r.id, r]));
}

/**
 * The display entries of these events, in the order given: none for an event
 * the feed doesn't show, several for an `issue.updated` that changed several
 * fields.
 */
export const entriesOf = (db: Db, events: ActivityEvent[]): EntryView[] =>
  entriesByEvent(db, events).flat();

/** `entriesOf`, kept apart per event: the i-th list holds the i-th event's entries. */
export function entriesByEvent(db: Db, events: ActivityEvent[]): EntryView[][] {
  if (events.length === 0) return [];
  const comments = rowsFor(
    events,
    (e) => e.action === "comment.created",
    (ids) => db.select().from(comment).where(inArray(comment.id, ids)).all(),
  );
  const issueIds = events
    .map((e) =>
      e.subjectType === "issue"
        ? e.subjectId
        : comments.get(e.subjectId)?.issueId,
    )
    .filter((id) => id !== undefined);
  const items = new Map<string, ItemRef>(
    (issueIds.length === 0
      ? []
      : db
          .select({
            id: issue.id,
            key: sql<string>`${product.key} || '-' || ${issue.number}`,
            title: issue.title,
            type: issue.type,
            sourceAuthor: issue.sourceAuthor,
          })
          .from(issue)
          .innerJoin(product, eq(product.id, issue.productId))
          .where(inArray(issue.id, issueIds))
          .all()
    ).map((i) => [i.id, i]),
  );
  const isUpdate = (e: ActivityEvent) => e.action === "status_update.created";
  const productUpdates = rowsFor(
    events,
    (e) => isUpdate(e) && e.productId !== null,
    (ids) =>
      db
        .select()
        .from(productStatusUpdate)
        .where(inArray(productStatusUpdate.id, ids))
        .all(),
  );
  const projectUpdates = rowsFor(
    events,
    (e) => isUpdate(e) && e.productId === null,
    (ids) =>
      db
        .select()
        .from(projectStatusUpdate)
        .where(inArray(projectStatusUpdate.id, ids))
        .all(),
  );
  const products = productRefs(
    db,
    events.flatMap((e) => (e.productId === null ? [] : [e.productId])),
  );
  const projects = projectRefs(
    db,
    events.flatMap((e) => (e.projectId === null ? [] : [e.projectId])),
  );
  const actorOf = actorsById(db, [
    ...events.map((e) => e.actorId),
    ...events.flatMap(assigneeIds),
  ]);

  return events.map((event) => {
    const productRef =
      event.productId === null ? undefined : products(event.productId);
    const projectRef =
      event.projectId === null ? undefined : projects(event.projectId);
    const itemRef = (id: string | undefined): WebItemRefView | undefined => {
      const found = id === undefined ? undefined : items.get(id);
      return found && { key: found.key, title: found.title, type: found.type };
    };
    const shared = {
      createdAt: event.createdAt.toISOString(),
      actor: actorOf(event.actorId),
    };
    const parts = partsOf(event);
    return parts.map((part, i) => ({
      id: parts.length === 1 ? event.id : `${event.id}:${i}`,
      ...shared,
      ...part,
    })) as EntryView[];

    function onItem(id: string | undefined, entries: EntryPart[]) {
      const target = itemRef(id);
      if (!target || !productRef) return [];
      return entries.map((part) => ({
        ...part,
        product: productRef,
        project: null,
        item: target,
      }));
    }

    function onProduct(entries: EntryPart[]) {
      if (!productRef) return [];
      return entries.map((part) => ({
        ...part,
        product: productRef,
        project: null,
        item: null,
      }));
    }

    function onProject(entries: EntryPart[]) {
      if (!projectRef) return [];
      return entries.map((part) => ({
        ...part,
        product: null,
        project: projectRef,
        item: null,
      }));
    }

    function partsOf(e: ActivityEvent) {
      switch (e.action) {
        case "product.created":
          return onProduct([{ kind: "product_created" }]);
        case "product.imported": {
          const counts = importedEventPayload.safeParse(e.payload);
          if (!counts.success) return [];
          const { created, updated } = counts.data;
          return onProduct([
            {
              kind: "product_imported",
              imported: {
                issues: created.issues + updated.issues,
                comments: created.comments + updated.comments,
              },
            },
          ]);
        }
        case "issue.created": {
          const created = items.get(e.subjectId);
          if (!created) return [];
          return onItem(e.subjectId, [
            {
              kind: "item_created",
              sourceAuthor: created.sourceAuthor,
              createdAs: createdAs(e.payload, shared.actor, created.type),
            },
          ]);
        }
        case "issue.updated":
          return onItem(
            e.subjectId,
            changeEntries(e.payload as IssueChanges, actorOf),
          );
        case "comment.created": {
          const row = comments.get(e.subjectId);
          if (!row) return [];
          return onItem(row.issueId, [
            {
              kind: "comment",
              comment: {
                id: row.id,
                body: row.body,
                sourceAuthor: row.sourceAuthor,
              },
            },
          ]);
        }
        case "project.item_added":
        case "project.item_removed": {
          const target = itemRef(e.subjectId);
          if (!target || !productRef || !projectRef) return [];
          return [
            {
              kind:
                e.action === "project.item_added"
                  ? ("added_to_project" as const)
                  : ("removed_from_project" as const),
              product: productRef,
              project: projectRef,
              item: target,
            },
          ];
        }
        case "status_update.created": {
          const fromProduct = productUpdates.get(e.subjectId);
          if (fromProduct) {
            return onProduct([
              {
                kind: "product_status_update",
                statusUpdate: {
                  id: fromProduct.id,
                  body: fromProduct.body,
                  health: fromProduct.health,
                  sourceAuthor: fromProduct.sourceAuthor,
                },
              },
            ]);
          }
          const fromProject = projectUpdates.get(e.subjectId);
          if (!fromProject) return [];
          return onProject([
            {
              kind: "project_status_update",
              statusUpdate: {
                id: fromProject.id,
                body: fromProject.body,
                health: fromProject.health,
                sourceAuthor: null,
              },
            },
          ]);
        }
        case "project.created":
          return onProject([{ kind: "project_created" }]);
        case "project.updated": {
          const fields = Object.keys(e.payload as object);
          return onProject([
            {
              kind: "project_updated",
              changed: webProjectFields.filter((f) =>
                fields.some((k) => projectFieldOf[k] === f),
              ),
            },
          ]);
        }
        default:
          return [];
      }
    }
  });
}

/** The products with these ids as key and name, by id. */
export function productRefs(
  db: Db,
  ids: string[],
): (id: string) => WebProductRefView {
  const wanted = [...new Set(ids)];
  const rows =
    wanted.length === 0
      ? []
      : db
          .select({ id: product.id, key: product.key, name: product.name })
          .from(product)
          .where(inArray(product.id, wanted))
          .all();
  const byId = new Map(rows.map((r) => [r.id, { key: r.key, name: r.name }]));
  return (id) => byId.get(id) as WebProductRefView;
}

/** The projects with these ids as slug and name, by id. */
function projectRefs(db: Db, ids: string[]): (id: string) => WebProjectRefView {
  const wanted = [...new Set(ids)];
  const rows =
    wanted.length === 0
      ? []
      : db
          .select({ id: project.id, slug: project.slug, name: project.name })
          .from(project)
          .where(inArray(project.id, wanted))
          .all();
  const byId = new Map(rows.map((r) => [r.id, { slug: r.slug, name: r.name }]));
  return (id) => byId.get(id) as WebProjectRefView;
}

/**
 * An item's timeline, oldest first: its filing, its comments, the changes the
 * feed shows and its being added to or removed from projects.
 */
export function timelineOf(
  db: Db,
  target: typeof issue.$inferSelect,
  itemRef: WebItemRefView,
  productRef: WebProductRefView,
): EntryView[] {
  const comments = db
    .select()
    .from(comment)
    .where(eq(comment.issueId, target.id))
    .orderBy(comment.createdAt, comment.id)
    .all();
  const changes = db
    .select()
    .from(activityEvent)
    .where(
      and(
        eq(activityEvent.subjectType, "issue"),
        eq(activityEvent.subjectId, target.id),
        inArray(activityEvent.action, [
          "issue.updated",
          "project.item_added",
          "project.item_removed",
        ]),
      ),
    )
    .orderBy(activityEvent.seq)
    .all();
  const createdEvent = db
    .select({ payload: activityEvent.payload })
    .from(activityEvent)
    .where(
      and(
        eq(activityEvent.subjectType, "issue"),
        eq(activityEvent.subjectId, target.id),
        eq(activityEvent.action, "issue.created"),
      ),
    )
    .get();
  const actorOf = actorsById(db, [
    target.createdBy,
    ...comments.map((c) => c.authorId),
  ]);
  const creator = actorOf(target.createdBy);
  const base = { product: productRef, item: itemRef };
  const entries: EntryView[] = [
    {
      id: target.id,
      kind: "item_created",
      createdAt: target.createdAt.toISOString(),
      actor: creator,
      ...base,
      project: null,
      sourceAuthor: target.sourceAuthor,
      createdAs: createdAs(createdEvent?.payload, creator, target.type),
    },
    ...comments.map(
      (c): EntryView => ({
        id: c.id,
        kind: "comment",
        createdAt: c.createdAt.toISOString(),
        actor: actorOf(c.authorId),
        ...base,
        project: null,
        comment: { id: c.id, body: c.body, sourceAuthor: c.sourceAuthor },
      }),
    ),
    // the item as it reads now, whatever its title was then
    ...entriesOf(db, changes).map((e) => ({ ...e, ...base }) as EntryView),
  ];
  // stable: at one instant the filing comes first, then comments, then changes
  return entries.sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}
