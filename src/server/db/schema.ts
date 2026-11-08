import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { newId } from "./id.js";

export const actorKinds = ["human", "bot"] as const;
export const issueStatuses = [
  "open",
  "in_progress",
  "done",
  "canceled",
] as const;
export const activitySubjectTypes = ["project", "issue", "comment"] as const;

export type ActorKind = (typeof actorKinds)[number];
export type IssueStatus = (typeof issueStatuses)[number];
export type ActivitySubjectType = (typeof activitySubjectTypes)[number];

// Unqualified column name for CHECKs and index predicates: drizzle renders a column as
// "table"."col", which fails in the `__new_<table>` copy drizzle-kit builds for a rebuild.
const c = (column: AnySQLiteColumn) => sql.identifier(column.name);

// the enum check is spelled from the same tuple the TS type comes from
const oneOf = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${c(column)} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => newId());
// Unix epoch milliseconds, read back as Date
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());

export const actor = sqliteTable(
  "actor",
  {
    id: id(),
    kind: text("kind", { enum: actorKinds }).notNull(),
    displayName: text("display_name").notNull(),
    githubId: integer("github_id").unique(),
    createdAt: createdAt(),
  },
  (t) => [
    check("actor_kind_check", oneOf(t.kind, actorKinds)),
    check("actor_display_name_check", sql`length(${c(t.displayName)}) > 0`),
    check(
      "actor_github_id_check",
      sql`${c(t.kind)} = 'human' or ${c(t.githubId)} is null`,
    ),
    // target of api_key's (actor_id, actor_kind) key, which pins keys to bots
    unique("actor_id_kind_unique").on(t.id, t.kind),
  ],
);

export const apiKey = sqliteTable(
  "api_key",
  {
    id: id(),
    actorId: text("actor_id").notNull(),
    actorKind: text("actor_kind", { enum: ["bot"] })
      .notNull()
      .default("bot"),
    prefix: text("prefix").notNull().unique(),
    // hex sha256 of the full key
    hash: text("hash").notNull(),
    createdAt: createdAt(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    foreignKey({
      columns: [t.actorId, t.actorKind],
      foreignColumns: [actor.id, actor.kind],
    }),
    check("api_key_actor_kind_check", sql`${c(t.actorKind)} = 'bot'`),
    check("api_key_hash_check", sql`length(${c(t.hash)}) = 64`),
  ],
);

export const project = sqliteTable(
  "project",
  {
    id: id(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdBy: text("created_by")
      .notNull()
      .references(() => actor.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("project_name_check", sql`length(${c(t.name)}) > 0`)],
);

export const issue = sqliteTable(
  "issue",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: issueStatuses }).notNull().default("open"),
    assigneeId: text("assignee_id").references(() => actor.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => actor.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("issue_status_check", oneOf(t.status, issueStatuses)),
    check("issue_title_check", sql`length(${c(t.title)}) > 0`),
    index("issue_project_status_created_idx").on(
      t.projectId,
      t.status,
      t.createdAt,
      t.id,
    ),
    index("issue_assignee_created_idx")
      .on(t.assigneeId, t.createdAt, t.id)
      .where(sql`${c(t.assigneeId)} is not null`),
  ],
);

export const comment = sqliteTable(
  "comment",
  {
    id: id(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issue.id),
    authorId: text("author_id")
      .notNull()
      .references(() => actor.id),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("comment_body_check", sql`length(${c(t.body)}) > 0`),
    index("comment_issue_created_idx").on(t.issueId, t.createdAt, t.id),
  ],
);

export const activityEvent = sqliteTable(
  "activity_event",
  {
    id: id(),
    actorId: text("actor_id")
      .notNull()
      .references(() => actor.id),
    subjectType: text("subject_type", { enum: activitySubjectTypes }).notNull(),
    // polymorphic over subject_type, so no foreign key
    subjectId: text("subject_id").notNull(),
    projectId: text("project_id").references(() => project.id),
    action: text("action").notNull(),
    payload: text("payload", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "activity_event_subject_type_check",
      oneOf(t.subjectType, activitySubjectTypes),
    ),
    check("activity_event_action_check", sql`length(${c(t.action)}) > 0`),
    check("activity_event_payload_check", sql`json_valid(${c(t.payload)})`),
    index("activity_event_created_idx").on(t.createdAt, t.id),
    index("activity_event_project_created_idx").on(
      t.projectId,
      t.createdAt,
      t.id,
    ),
    index("activity_event_actor_created_idx").on(t.actorId, t.createdAt, t.id),
  ],
);
