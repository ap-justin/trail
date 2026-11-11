import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type {
  EntryView,
  WebActorView,
  WebProjectRefView,
} from "../../shared/schemas.js";
import type { Db } from "../db/client.js";
import {
  activityEvent,
  comment,
  type IssueStatus,
  issue,
  project,
  projectStatusUpdate,
} from "../db/schema.js";
import type { ActivityEvent } from "../events/bus.js";
import type { Link } from "../service/index.js";
import { actorsById } from "./visible.js";

type Change<T> = { from: T; to: T };

/** The part of an `issue.updated` payload (field → from/to) the feed shows. */
type IssueChanges = {
  status?: Change<IssueStatus>;
  priority?: Change<number>;
  labels?: Change<string[]>;
  links?: Change<Link[]>;
  assigneeId?: Change<string | null>;
  estimate?: Change<number | null>;
};

const shownActions = [
  "project.created",
  "issue.created",
  "comment.created",
  "status_update.created",
];

const changed = (field: string) =>
  sql`json_type(${activityEvent.payload}, ${`$.${field}`}) is not null`;

/**
 * The events that become at least one entry: a page of them is never empty of
 * entries. An `issue.updated` shows only when it changed a field the feed
 * shows; a links change only when it added a url.
 */
export const shownEvent: SQL = or(
  inArray(activityEvent.action, shownActions),
  and(
    eq(activityEvent.action, "issue.updated"),
    or(
      changed("status"),
      changed("priority"),
      changed("labels"),
      changed("assigneeId"),
      changed("estimate"),
      sql`exists (select 1 from json_each(${activityEvent.payload}, '$.links.to') t where t.value ->> 'url' not in (select f.value ->> 'url' from json_each(${activityEvent.payload}, '$.links.from') f))`,
    ),
  ),
) as SQL;

type IssueRef = {
  id: string;
  key: string;
  title: string;
  sourceAuthor: string | null;
};

/** The bits of an issue's changes the feed shows, each one entry, in a fixed order. */
function changeEntries(
  changes: IssueChanges,
  actorOf: (id: string) => WebActorView,
) {
  const parts: DistributiveOmit<
    EntryView,
    "id" | "createdAt" | "actor" | "project" | "issue"
  >[] = [];
  if (changes.status) parts.push({ kind: "status_changed", ...changes.status });
  if (changes.priority) {
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
  if (changes.assigneeId) {
    const { from, to } = changes.assigneeId;
    parts.push({
      kind: "assignee_changed",
      from: from === null ? null : actorOf(from),
      to: to === null ? null : actorOf(to),
    });
  }
  if (changes.estimate) {
    parts.push({ kind: "estimate_changed", ...changes.estimate });
  }
  return parts;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** The actor ids an `issue.updated` payload names as assignees. */
const assigneeIds = (event: ActivityEvent) => {
  const change = (event.payload as IssueChanges).assigneeId;
  return change ? [change.from, change.to] : [];
};

/**
 * The display entries of these events, in the order given: none for an event
 * the feed doesn't show, several for an `issue.updated` that changed several
 * fields. Every event must have a project.
 */
export function entriesOf(db: Db, events: ActivityEvent[]): EntryView[] {
  if (events.length === 0) return [];
  const commentIds = events
    .filter((e) => e.action === "comment.created")
    .map((e) => e.subjectId);
  const comments = new Map(
    (commentIds.length === 0
      ? []
      : db.select().from(comment).where(inArray(comment.id, commentIds)).all()
    ).map((c) => [c.id, c]),
  );
  const issueIds = events
    .map((e) =>
      e.subjectType === "issue"
        ? e.subjectId
        : comments.get(e.subjectId)?.issueId,
    )
    .filter((id) => id !== undefined);
  const issues = new Map<string, IssueRef>(
    (issueIds.length === 0
      ? []
      : db
          .select({
            id: issue.id,
            key: sql<string>`${project.key} || '-' || ${issue.number}`,
            title: issue.title,
            sourceAuthor: issue.sourceAuthor,
          })
          .from(issue)
          .innerJoin(project, eq(project.id, issue.projectId))
          .where(inArray(issue.id, issueIds))
          .all()
    ).map((i) => [i.id, i]),
  );
  const updateIds = events
    .filter((e) => e.action === "status_update.created")
    .map((e) => e.subjectId);
  const updates = new Map(
    (updateIds.length === 0
      ? []
      : db
          .select()
          .from(projectStatusUpdate)
          .where(inArray(projectStatusUpdate.id, updateIds))
          .all()
    ).map((u) => [u.id, u]),
  );
  const projects = projectRefs(
    db,
    events.map((e) => e.projectId as string),
  );
  const actorOf = actorsById(db, [
    ...events.map((e) => e.actorId),
    ...events.flatMap(assigneeIds),
  ]);

  return events.flatMap((event) => {
    const base = {
      createdAt: event.createdAt.toISOString(),
      actor: actorOf(event.actorId),
      project: projects(event.projectId as string),
    };
    const ref = (id: string | undefined) => {
      const found = id === undefined ? undefined : issues.get(id);
      return found ? { key: found.key, title: found.title } : null;
    };
    const parts = partsOf(event);
    return parts.map((part, i) => ({
      id: parts.length === 1 ? event.id : `${event.id}:${i}`,
      ...base,
      ...part,
    })) as EntryView[];

    function partsOf(e: ActivityEvent) {
      switch (e.action) {
        case "project.created":
          return [{ kind: "project_created" as const, issue: null }];
        case "issue.created": {
          const target = ref(e.subjectId);
          if (!target) return [];
          return [
            {
              kind: "issue_created" as const,
              issue: target,
              sourceAuthor: issues.get(e.subjectId)?.sourceAuthor ?? null,
            },
          ];
        }
        case "issue.updated": {
          const target = ref(e.subjectId);
          if (!target) return [];
          return changeEntries(e.payload as IssueChanges, actorOf).map(
            (part) => ({ ...part, issue: target }),
          );
        }
        case "comment.created": {
          const row = comments.get(e.subjectId);
          const target = ref(row?.issueId);
          if (!row || !target) return [];
          return [
            {
              kind: "comment" as const,
              issue: target,
              comment: {
                id: row.id,
                body: row.body,
                sourceAuthor: row.sourceAuthor,
              },
            },
          ];
        }
        case "status_update.created": {
          const row = updates.get(e.subjectId);
          if (!row) return [];
          return [
            {
              kind: "status_update" as const,
              issue: null,
              statusUpdate: {
                id: row.id,
                body: row.body,
                health: row.health,
                sourceAuthor: row.sourceAuthor,
              },
            },
          ];
        }
        default:
          return [];
      }
    }
  });
}

/** The projects with these ids as key and name, by id. */
export function projectRefs(
  db: Db,
  ids: string[],
): (id: string) => WebProjectRefView {
  const wanted = [...new Set(ids)];
  const rows =
    wanted.length === 0
      ? []
      : db
          .select({ id: project.id, key: project.key, name: project.name })
          .from(project)
          .where(inArray(project.id, wanted))
          .all();
  const byId = new Map(rows.map((r) => [r.id, { key: r.key, name: r.name }]));
  return (id) => byId.get(id) as WebProjectRefView;
}

/** An issue's timeline, oldest first: its filing, its comments and the changes the feed shows. */
export function timelineOf(
  db: Db,
  target: typeof issue.$inferSelect,
  issueRef: { key: string; title: string },
  projectRef: WebProjectRefView,
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
        eq(activityEvent.action, "issue.updated"),
      ),
    )
    .orderBy(activityEvent.seq)
    .all();
  const actorOf = actorsById(db, [
    target.createdBy,
    ...comments.map((c) => c.authorId),
  ]);
  const base = { project: projectRef, issue: issueRef };
  const entries: EntryView[] = [
    {
      id: target.id,
      kind: "issue_created",
      createdAt: target.createdAt.toISOString(),
      actor: actorOf(target.createdBy),
      ...base,
      sourceAuthor: target.sourceAuthor,
    },
    ...comments.map(
      (c): EntryView => ({
        id: c.id,
        kind: "comment",
        createdAt: c.createdAt.toISOString(),
        actor: actorOf(c.authorId),
        ...base,
        comment: { id: c.id, body: c.body, sourceAuthor: c.sourceAuthor },
      }),
    ),
    ...entriesOf(db, changes).map((e) => ({ ...e, ...base }) as EntryView),
  ];
  // stable: at one instant the filing comes first, then comments, then changes
  return entries.sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}
