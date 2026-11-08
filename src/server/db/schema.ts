import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { newId } from "./id.js";

export const actorKinds = ["human", "bot"] as const;
export const issueStatuses = [
  "open",
  "in_progress",
  "done",
  "canceled",
] as const;
// the statuses that carry a completed_at
const completedStatuses = [
  "done",
  "canceled",
] as const satisfies readonly IssueStatus[];
export const projectHealths = ["on_track", "at_risk", "off_track"] as const;
export const activitySubjectTypes = [
  "project",
  "issue",
  "comment",
  "label",
  "status_update",
] as const;

export type ActorKind = (typeof actorKinds)[number];
export type IssueStatus = (typeof issueStatuses)[number];
export type ProjectHealth = (typeof projectHealths)[number];
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
    // a bot's agent id in the system that runs it
    label: text("label"),
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
    uniqueIndex("actor_bot_display_name_unique")
      .on(t.displayName)
      .where(sql`${c(t.kind)} = 'bot'`),
    uniqueIndex("actor_bot_label_unique")
      .on(t.label)
      .where(sql`${c(t.kind)} = 'bot' and ${c(t.label)} is not null`),
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
    // prefix of its issues' identifiers, as in TRL-12
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    // the last issue number handed out in this project
    issueSeq: integer("issue_seq").notNull().default(0),
    externalRef: text("external_ref"),
    createdBy: text("created_by")
      .notNull()
      .references(() => actor.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("project_name_check", sql`length(${c(t.name)}) > 0`),
    check(
      "project_key_check",
      sql`length(${c(t.key)}) between 2 and 10 and ${c(t.key)} not glob '*[^A-Z0-9]*'`,
    ),
    check("project_issue_seq_check", sql`${c(t.issueSeq)} >= 0`),
    uniqueIndex("project_external_ref_unique")
      .on(t.externalRef)
      .where(sql`${c(t.externalRef)} is not null`),
  ],
);

export const issue = sqliteTable(
  "issue",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    // from 1 within the project: project.issue_seq + 1, bumped in the same transaction
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: issueStatuses }).notNull().default("open"),
    // hours
    estimate: real("estimate"),
    // 0 none, 1 urgent, 2 high, 3 medium, 4 low
    priority: integer("priority").notNull().default(0),
    assigneeId: text("assignee_id").references(() => actor.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => actor.id),
    externalRef: text("external_ref"),
    // the original author's name on an imported row, which created_by credits to the importing bot
    sourceAuthor: text("source_author"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    check("issue_status_check", oneOf(t.status, issueStatuses)),
    check("issue_title_check", sql`length(${c(t.title)}) > 0`),
    check("issue_number_check", sql`${c(t.number)} > 0`),
    unique("issue_project_number_unique").on(t.projectId, t.number),
    check("issue_estimate_check", sql`${c(t.estimate)} >= 0`),
    check("issue_priority_check", sql`${c(t.priority)} between 0 and 4`),
    check(
      "issue_completed_at_check",
      sql`(${oneOf(t.status, completedStatuses)}) = (${c(t.completedAt)} is not null)`,
    ),
    uniqueIndex("issue_project_external_ref_unique")
      .on(t.projectId, t.externalRef)
      .where(sql`${c(t.externalRef)} is not null`),
    // target of issue_label's (issue_id, project_id) key
    unique("issue_id_project_unique").on(t.id, t.projectId),
    index("issue_project_status_created_idx").on(
      t.projectId,
      t.status,
      t.createdAt,
      t.id,
    ),
    index("issue_project_created_idx").on(t.projectId, t.createdAt, t.id),
    index("issue_assignee_created_idx")
      .on(t.assigneeId, t.createdAt, t.id)
      .where(sql`${c(t.assigneeId)} is not null`),
  ],
);

export const label = sqliteTable(
  "label",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("label_name_check", sql`length(${c(t.name)}) > 0`),
    // nocase folds ASCII only: 'Équipe' and 'équipe' are two labels
    uniqueIndex("label_project_name_unique").on(
      t.projectId,
      sql`${c(t.name)} collate nocase`,
    ),
    // target of issue_label's (label_id, project_id) key
    unique("label_id_project_unique").on(t.id, t.projectId),
  ],
);

export const issueLabel = sqliteTable(
  "issue_label",
  {
    issueId: text("issue_id").notNull(),
    labelId: text("label_id").notNull(),
    // both keys below share it, so a label can only go on an issue in its own project
    projectId: text("project_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.issueId, t.labelId] }),
    foreignKey({
      columns: [t.issueId, t.projectId],
      foreignColumns: [issue.id, issue.projectId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.labelId, t.projectId],
      foreignColumns: [label.id, label.projectId],
    }).onDelete("cascade"),
  ],
);

export const issueLink = sqliteTable(
  "issue_link",
  {
    id: id(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issue.id),
    url: text("url").notNull(),
    title: text("title").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("issue_link_url_check", sql`length(${c(t.url)}) > 0`),
    check("issue_link_title_check", sql`length(${c(t.title)}) > 0`),
    unique("issue_link_issue_url_unique").on(t.issueId, t.url),
  ],
);

export const projectStatusUpdate = sqliteTable(
  "project_status_update",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    authorId: text("author_id")
      .notNull()
      .references(() => actor.id),
    body: text("body").notNull(),
    health: text("health", { enum: projectHealths }).notNull(),
    externalRef: text("external_ref"),
    sourceAuthor: text("source_author"),
    createdAt: createdAt(),
  },
  (t) => [
    check("project_status_update_body_check", sql`length(${c(t.body)}) > 0`),
    check(
      "project_status_update_health_check",
      oneOf(t.health, projectHealths),
    ),
    index("project_status_update_project_created_idx").on(
      t.projectId,
      t.createdAt,
      t.id,
    ),
    uniqueIndex("project_status_update_project_external_ref_unique")
      .on(t.projectId, t.externalRef)
      .where(sql`${c(t.externalRef)} is not null`),
  ],
);

/**
 * The first response to a create sent with an Idempotency-Key. A repeat whose
 * scope or request_hash differs from the stored row is a different request
 * reusing the key.
 */
export const idempotencyKey = sqliteTable(
  "idempotency_key",
  {
    actorId: text("actor_id")
      .notNull()
      .references(() => actor.id),
    key: text("key").notNull(),
    // the create operation, e.g. "project.create"
    scope: text("scope").notNull(),
    requestHash: text("request_hash").notNull(),
    response: text("response", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.key] }),
    check("idempotency_key_key_check", sql`length(${c(t.key)}) > 0`),
    check("idempotency_key_scope_check", sql`length(${c(t.scope)}) > 0`),
    check(
      "idempotency_key_request_hash_check",
      sql`length(${c(t.requestHash)}) > 0`,
    ),
    check("idempotency_key_response_check", sql`json_valid(${c(t.response)})`),
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
    externalRef: text("external_ref"),
    sourceAuthor: text("source_author"),
    createdAt: createdAt(),
  },
  (t) => [
    check("comment_body_check", sql`length(${c(t.body)}) > 0`),
    index("comment_issue_created_idx").on(t.issueId, t.createdAt, t.id),
    uniqueIndex("comment_issue_external_ref_unique")
      .on(t.issueId, t.externalRef)
      .where(sql`${c(t.externalRef)} is not null`),
  ],
);

export const activityEvent = sqliteTable(
  "activity_event",
  {
    id: id(),
    /**
     * Commit order, from 1: the insert reads max(seq) under the write lock, so
     * a later commit always takes a higher seq — which created_at and the
     * UUIDv7 id don't promise within one millisecond. A multi-row insert
     * computes one seq for every row and fails the unique index.
     */
    seq: integer("seq")
      .notNull()
      .$defaultFn(
        () =>
          sql`(select coalesce(max(${sql.identifier("seq")}), 0) + 1 from ${sql.identifier("activity_event")})`,
      ),
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
    check("activity_event_seq_check", sql`${c(t.seq)} > 0`),
    // the feed's keyset, both directions, overall and per project or actor
    uniqueIndex("activity_event_seq_unique").on(t.seq),
    index("activity_event_project_seq_idx").on(t.projectId, t.seq),
    index("activity_event_actor_seq_idx").on(t.actorId, t.seq),
  ],
);
