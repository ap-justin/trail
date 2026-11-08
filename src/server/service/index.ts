import { and, asc, desc, eq, gt, lt, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Db } from "../db/client.js";
import {
  activityEvent,
  actor as actorTable,
  comment,
  type IssueStatus,
  issue,
  issueStatuses,
  project,
} from "../db/schema.js";
import type { ActivityEvent, EventBus } from "../events/bus.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import type { Actor } from "./keys.js";

export type ActingActor = Pick<Actor, "id" | "kind">;
export type Project = typeof project.$inferSelect;
export type Issue = typeof issue.$inferSelect;
export type Comment = typeof comment.$inferSelect;
export type Page<T> = { items: T[]; nextCursor: string | null };
export type PageQuery = { cursor?: string; limit?: number };

export type ProjectInput = { name: string; description?: string };
export type ProjectPatch = { name?: string; description?: string };
export type IssueInput = {
  projectId: string;
  title: string;
  description?: string;
  assigneeId?: string | null;
};
export type IssuePatch = {
  title?: string;
  description?: string;
  status?: IssueStatus;
  /** null unassigns */
  assigneeId?: string | null;
};
export type IssueQuery = PageQuery & {
  projectId?: string;
  status?: IssueStatus;
  assigneeId?: string;
};
export type ActivityQuery = PageQuery & {
  projectId?: string;
  actorId?: string;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type NewEvent = Omit<typeof activityEvent.$inferInsert, "id" | "createdAt">;
type Change = { from: unknown; to: unknown };

const defaultLimit = 50;
const maxLimit = 200;

/** Only a bot may make this write; checked before the database is touched. */
function requireBot(actor: ActingActor, write: string): void {
  if (actor.kind !== "bot") {
    throw new ForbiddenError(`only a bot may ${write}`);
  }
}

function nonBlank(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new ValidationError(`${field} must not be empty`);
  return trimmed;
}

function validStatus(status: string): IssueStatus {
  if (!(issueStatuses as readonly string[]).includes(status)) {
    throw new ValidationError(
      `status must be one of ${issueStatuses.join(", ")}`,
    );
  }
  return status as IssueStatus;
}

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

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify([row.createdAt.getTime(), row.id]),
  ).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !Number.isSafeInteger(parsed[0]) ||
    typeof parsed[1] !== "string"
  ) {
    throw new ValidationError("cursor is invalid");
  }
  return { createdAt: new Date(parsed[0]), id: parsed[1] };
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new ValidationError(`limit must be an integer from 1 to ${maxLimit}`);
  }
  return limit;
}

type Keyset = { createdAt: SQLiteColumn; id: SQLiteColumn };

/**
 * One page ordered by (created_at, id) in `direction`, the cursor naming the
 * last row of the previous page. `run` gets the where clause, order and limit.
 */
function page<T extends { createdAt: Date; id: string }>(
  keys: Keyset,
  direction: "asc" | "desc",
  query: PageQuery,
  filters: (SQL | undefined)[],
  run: (where: SQL | undefined, orderBy: SQL[], limit: number) => T[],
): Page<T> {
  const limit = pageLimit(query.limit);
  const past = direction === "desc" ? lt : gt;
  const order = direction === "desc" ? desc : asc;
  if (query.cursor !== undefined) {
    const after = decodeCursor(query.cursor);
    filters.push(
      or(
        past(keys.createdAt, after.createdAt),
        and(eq(keys.createdAt, after.createdAt), past(keys.id, after.id)),
      ),
    );
  }
  const rows = run(
    and(...filters),
    [order(keys.createdAt), order(keys.id)],
    limit + 1,
  );
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

export function createService({ db, bus }: { db: Db; bus: EventBus }) {
  /**
   * Runs `write` and the activity event it returns in one immediate
   * transaction, then publishes the committed event. `write` returns a null
   * event when there is nothing to record, and the transaction writes nothing.
   */
  function commit<T>(
    write: (tx: Tx) => { result: T; event: NewEvent | null },
  ): T {
    const { result, event } = db.transaction(
      (tx) => {
        const { result, event } = write(tx);
        if (!event) return { result, event: null };
        const committed = tx
          .insert(activityEvent)
          .values(event)
          .returning()
          .get();
        return { result, event: committed };
      },
      { behavior: "immediate" },
    );
    if (event) bus.publish(event);
    return result;
  }

  function findProject(tx: Tx | Db, id: string): Project {
    const found = tx.select().from(project).where(eq(project.id, id)).get();
    if (!found) throw new NotFoundError(`no project ${id}`);
    return found;
  }

  function findIssue(tx: Tx | Db, id: string): Issue {
    const found = tx.select().from(issue).where(eq(issue.id, id)).get();
    if (!found) throw new NotFoundError(`no issue ${id}`);
    return found;
  }

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

  return {
    createProject(actor: ActingActor, input: ProjectInput): Project {
      requireBot(actor, "create a project");
      const name = nonBlank(input.name, "name");
      return commit((tx) => {
        const created = tx
          .insert(project)
          .values({
            name,
            description: input.description,
            createdBy: actor.id,
          })
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
            payload: { name: created.name, description: created.description },
          },
        };
      });
    },

    /** A patch that changes nothing writes nothing and emits no event. */
    updateProject(
      actor: ActingActor,
      id: string,
      patch: ProjectPatch,
    ): Project {
      requireBot(actor, "update a project");
      const next: ProjectPatch = {
        name:
          patch.name === undefined ? undefined : nonBlank(patch.name, "name"),
        description: patch.description,
      };
      return commit((tx) => {
        const current = findProject(tx, id);
        const changes = changesOf(current, next);
        if (Object.keys(changes).length === 0) {
          return { result: current, event: null };
        }
        const updated = tx
          .update(project)
          .set(next)
          .where(eq(project.id, id))
          .returning()
          .get() as Project;
        return {
          result: updated,
          event: {
            actorId: actor.id,
            subjectType: "project",
            subjectId: id,
            projectId: id,
            action: "project.updated",
            payload: changes,
          },
        };
      });
    },

    createIssue(actor: ActingActor, input: IssueInput): Issue {
      const title = nonBlank(input.title, "title");
      return commit((tx) => {
        findProject(tx, input.projectId);
        requireAssignee(tx, input.assigneeId);
        const created = tx
          .insert(issue)
          .values({
            projectId: input.projectId,
            title,
            description: input.description,
            assigneeId: input.assigneeId,
            createdBy: actor.id,
          })
          .returning()
          .get();
        return {
          result: created,
          event: {
            actorId: actor.id,
            subjectType: "issue",
            subjectId: created.id,
            projectId: created.projectId,
            action: "issue.created",
            payload: {
              title: created.title,
              description: created.description,
              status: created.status,
              assigneeId: created.assigneeId,
            },
          },
        };
      });
    },

    /** A patch that changes nothing writes nothing and emits no event. */
    updateIssue(actor: ActingActor, id: string, patch: IssuePatch): Issue {
      requireBot(actor, "update an issue");
      const next: IssuePatch = {
        title:
          patch.title === undefined
            ? undefined
            : nonBlank(patch.title, "title"),
        description: patch.description,
        status:
          patch.status === undefined ? undefined : validStatus(patch.status),
        assigneeId: patch.assigneeId,
      };
      return commit((tx) => {
        const current = findIssue(tx, id);
        const changes = changesOf(current, next);
        if (Object.keys(changes).length === 0) {
          return { result: current, event: null };
        }
        if ("assigneeId" in changes) requireAssignee(tx, next.assigneeId);
        const updated = tx
          .update(issue)
          .set(next)
          .where(eq(issue.id, id))
          .returning()
          .get() as Issue;
        return {
          result: updated,
          event: {
            actorId: actor.id,
            subjectType: "issue",
            subjectId: id,
            projectId: current.projectId,
            action: "issue.updated",
            payload: changes,
          },
        };
      });
    },

    addComment(
      actor: ActingActor,
      input: { issueId: string; body: string },
    ): Comment {
      if (input.body.trim() === "") {
        throw new ValidationError("body must not be empty");
      }
      return commit((tx) => {
        const target = findIssue(tx, input.issueId);
        const created = tx
          .insert(comment)
          .values({ issueId: target.id, authorId: actor.id, body: input.body })
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
            payload: { issueId: target.id, body: created.body },
          },
        };
      });
    },

    getProject(_actor: ActingActor, id: string): Project {
      return findProject(db, id);
    },

    /** Newest first. */
    listProjects(_actor: ActingActor, query: PageQuery = {}): Page<Project> {
      return page(project, "desc", query, [], (where, orderBy, limit) =>
        db
          .select()
          .from(project)
          .where(where)
          .orderBy(...orderBy)
          .limit(limit)
          .all(),
      );
    },

    getIssue(_actor: ActingActor, id: string): Issue {
      return findIssue(db, id);
    },

    /** Newest first. */
    listIssues(_actor: ActingActor, query: IssueQuery = {}): Page<Issue> {
      const filters = [
        query.projectId === undefined
          ? undefined
          : eq(issue.projectId, query.projectId),
        query.status === undefined
          ? undefined
          : eq(issue.status, validStatus(query.status)),
        query.assigneeId === undefined
          ? undefined
          : eq(issue.assigneeId, query.assigneeId),
      ];
      return page(issue, "desc", query, filters, (where, orderBy, limit) =>
        db
          .select()
          .from(issue)
          .where(where)
          .orderBy(...orderBy)
          .limit(limit)
          .all(),
      );
    },

    /** Oldest first, the order an issue's thread reads in. */
    listComments(
      _actor: ActingActor,
      issueId: string,
      query: PageQuery = {},
    ): Page<Comment> {
      findIssue(db, issueId);
      return page(
        comment,
        "asc",
        query,
        [eq(comment.issueId, issueId)],
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
    listActivity(
      _actor: ActingActor,
      query: ActivityQuery = {},
    ): Page<ActivityEvent> {
      const filters = [
        query.projectId === undefined
          ? undefined
          : eq(activityEvent.projectId, query.projectId),
        query.actorId === undefined
          ? undefined
          : eq(activityEvent.actorId, query.actorId),
      ];
      return page(
        activityEvent,
        "desc",
        query,
        filters,
        (where, orderBy, limit) =>
          db
            .select()
            .from(activityEvent)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
    },
  };
}

export type Service = ReturnType<typeof createService>;
