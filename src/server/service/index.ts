import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  activityEvent,
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
} from "../db/schema.js";
import type { ActivityEvent, EventBus } from "../events/bus.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
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
import type { Actor } from "./keys.js";
import {
  decodeFeedCursor,
  encodeFeedCursor,
  type FeedFilters,
  type Page,
  type PageQuery,
  page,
  pageLimit,
} from "./paging.js";
import type { Tx } from "./tx.js";
import {
  completedAtOf,
  type Link,
  type LinkInput,
  labelKey,
  nonBlank,
  optionalRef,
  validEstimate,
  validHealth,
  validLabelNames,
  validLinks,
  validPriority,
  validProjectKey,
  validStatus,
} from "./validate.js";

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

export type ActingActor = Pick<Actor, "id" | "kind">;
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
export type ImportResult = {
  project: Project;
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

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export function createService({ db, bus }: { db: Db; bus: EventBus }) {
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

  /** The project with this id, or else this key (in any case). */
  function resolveProject(tx: Tx | Db, ref: string): Project {
    const found =
      tx.select().from(project).where(eq(project.id, ref)).get() ??
      tx.select().from(project).where(eq(project.key, ref.toUpperCase())).get();
    if (!found) {
      throw new NotFoundError(
        `no project ${ref}: pass the id or key (like TRL) of an existing project`,
      );
    }
    return found;
  }

  /** The issue with this id, or else this key (TRL-12, the project key in any case). */
  function resolveIssueRow(tx: Tx | Db, ref: string): IssueRow {
    const byId = tx.select().from(issue).where(eq(issue.id, ref)).get();
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
          ),
        )
        .get()?.issue;
    if (!byKey) {
      throw new NotFoundError(
        `no issue ${ref}: pass the id or key (like TRL-12) of an existing issue`,
      );
    }
    return byKey;
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
   * externalRef is the project's own key form (JUS-187) keeps that number, so
   * its key still resolves; the project's sequence moves past the highest kept,
   * then numbers the rest by (createdAt, externalRef), whatever the payload order.
   */
  function importNumbers(
    tx: Tx,
    target: Project,
    rows: NormalIssue[],
  ): Map<string, number> {
    const ownKey = new RegExp(`^${target.key}-([1-9]\\d*)$`);
    const numbers = new Map<string, number>();
    const sequenced: NormalIssue[] = [];
    for (const row of rows) {
      const number = Number(ownKey.exec(row.externalRef)?.[1]);
      if (!Number.isSafeInteger(number)) {
        sequenced.push(row);
        continue;
      }
      const holder = tx
        .select()
        .from(issue)
        .where(and(eq(issue.projectId, target.id), eq(issue.number, number)))
        .get();
      if (holder) {
        throw new ConflictError(
          `issue ${row.externalRef} keeps its number, but ${target.key}-${number} is already issue ${holder.id} ("${holder.title}", externalRef ${holder.externalRef ?? "none"}): import into a project without that issue, or send a different externalRef`,
        );
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
    for (const row of sequenced) {
      numbers.set(row.externalRef, nextIssueNumber(tx, target.id));
    }
    return numbers;
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

  /** The project's labels by `labelKey`, each payload name created when missing. */
  function importLabels(
    tx: Tx,
    projectId: string,
    names: string[],
    tally: Tally,
  ): Map<string, Label> {
    const labels = new Map<string, Label>();
    for (const name of names) {
      const found = findLabel(tx, projectId, name);
      tally[found ? "unchanged" : "created"].labels++;
      labels.set(
        labelKey(name),
        found ?? tx.insert(label).values({ projectId, name }).returning().get(),
      );
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
          sourceStatus: row.sourceStatus ?? null,
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
      const next: ProjectPatch = {
        name:
          patch.name === undefined ? undefined : nonBlank(patch.name, "name"),
        description: patch.description,
      };
      return commit((tx) => {
        const current = resolveProject(tx, ref);
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
        const target = resolveProject(tx, input.projectId);
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
      const labelNames =
        patch.labels === undefined ? undefined : validLabelNames(patch.labels);
      const links =
        patch.links === undefined ? undefined : validLinks(patch.links);
      return commit((tx) => {
        const row = resolveIssueRow(tx, ref);
        const current = hydrateOne(tx, row);
        const changes = changesOf<IssueRow>(row, next);
        if ("assigneeId" in changes) requireAssignee(tx, next.assigneeId);
        let labels: Label[] | undefined;
        if (labelNames !== undefined) {
          labels = labelsNamed(tx, row.projectId, labelNames);
          const to = sortedNames(labels);
          if (!sameJson(current.labels, to)) {
            changes.labels = { from: current.labels, to };
          }
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
      if (input.body.trim() === "") {
        throw new ValidationError("body must not be empty");
      }
      const externalRef = optionalRef(input.externalRef);
      return create(actor, options, "comment.create", (tx) => {
        const target = resolveIssueRow(tx, input.issueId);
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
      const body = input.body;
      if (body.trim() === "") {
        throw new ValidationError("body must not be empty");
      }
      const health = validHealth(input.health);
      const externalRef = optionalRef(input.externalRef);
      return create(actor, options, "status_update.create", (tx) => {
        const target = resolveProject(tx, input.projectId);
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
      const name = nonBlank(input.name, "name");
      return create(actor, options, "label.create", (tx) => {
        const target = resolveProject(tx, input.projectId);
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
        const numbers = importNumbers(
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
            payload: { externalRef: target.externalRef, ...tally },
          },
        };
      });
    },

    getProject(_actor: ActingActor, ref: string): Project {
      return resolveProject(db, ref);
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

    getIssue(_actor: ActingActor, ref: string): Issue {
      return hydrateOne(db, resolveIssueRow(db, ref));
    },

    /** Newest first. */
    listIssues(_actor: ActingActor, query: IssueQuery = {}): Page<Issue> {
      const filters = [
        query.projectId === undefined
          ? undefined
          : eq(issue.projectId, resolveProject(db, query.projectId).id),
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
      _actor: ActingActor,
      issueRef: string,
      query: PageQuery = {},
    ): Page<Comment> {
      const target = resolveIssueRow(db, issueRef);
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
      _actor: ActingActor,
      projectRef: string,
      query: PageQuery = {},
    ): Page<StatusUpdate> {
      const target = resolveProject(db, projectRef);
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
      _actor: ActingActor,
      projectRef: string,
      query: PageQuery = {},
    ): Page<Label> {
      const target = resolveProject(db, projectRef);
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

    /** The calling actor, as stored; actors are never deleted, so the row is there. */
    whoami(actor: ActingActor): Actor {
      return db
        .select()
        .from(actorTable)
        .where(eq(actorTable.id, actor.id))
        .get() as Actor;
    },

    /** Every bot, oldest first. */
    listBots(_actor: ActingActor, query: PageQuery = {}): Page<Actor> {
      return page(
        actorTable,
        "asc",
        query,
        [eq(actorTable.kind, "bot")],
        (where, orderBy, limit) =>
          db
            .select()
            .from(actorTable)
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all(),
      );
    },

    /**
     * In commit order (`seq`): newest first with `cursor`, oldest first after
     * `after`. Either cursor is bound to the filters it was issued under.
     */
    listActivity(
      _actor: ActingActor,
      query: ActivityQuery = {},
    ): Page<ActivityEvent> {
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
            : resolveProject(db, query.projectId).id,
        actorId: query.actorId ?? null,
      };
      const where: (SQL | undefined)[] = [
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
          query.after === "" ? 0 : decodeFeedCursor(query.after, filters);
        where.push(gt(activityEvent.seq, from));
        const items = select(asc(activityEvent.seq), limit);
        const seq = items.at(-1)?.seq ?? from;
        return { items, nextCursor: encodeFeedCursor({ ...filters, seq }) };
      }

      if (query.cursor !== undefined) {
        where.push(
          lt(activityEvent.seq, decodeFeedCursor(query.cursor, filters)),
        );
      }
      const rows = select(desc(activityEvent.seq), limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? encodeFeedCursor({ ...filters, seq: last.seq })
            : null,
      };
    },
  };
}

export type Service = ReturnType<typeof createService>;
