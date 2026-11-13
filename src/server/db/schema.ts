import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
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
export const apiKeyActions = [
  "read",
  "issues",
  "comments",
  "status_updates",
  "admin",
] as const;
export type ApiKeyAction = (typeof apiKeyActions)[number];
export const actorPhotoContentTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export type ActorPhotoContentType = (typeof actorPhotoContentTypes)[number];

// Unqualified column name for CHECKs and index predicates: drizzle renders a column as
// "table"."col", which fails in the `__new_<table>` copy drizzle-kit builds for a rebuild.
const c = (column: AnySQLiteColumn) => sql.identifier(column.name);

// the enum check is spelled from the same tuple the TS type comes from
const literals = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(", "));
const oneOf = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${c(column)} in (${literals(values)})`;

// A non-empty JSON array of distinct members of `values`. CHECK allows no subquery, so no
// json_each: distinct members of an n-value set number at most n, so the check reads
// slots 0..n-1 by path. Each term stays non-null, since a CHECK passes on NULL.
const jsonSetOf = (column: AnySQLiteColumn, values: readonly string[]) => {
  const col = c(column);
  const length = sql`json_array_length(${col})`;
  const slot = (i: number) =>
    sql`json_extract(${col}, ${sql.raw(`'$[${i}]'`)})`;
  const slots = values.map((_, i) => i);
  const members = slots.map(
    (i) =>
      sql`(${length} <= ${sql.raw(String(i))} or ifnull(${slot(i)}, '') in (${literals(values)}))`,
  );
  const distinct = slots.flatMap((i) =>
    slots
      .filter((j) => j > i)
      .map(
        (j) =>
          sql`(${length} <= ${sql.raw(String(j))} or ${slot(i)} <> ${slot(j)})`,
      ),
  );
  // CASE, not AND: json_type and json_array_length raise on malformed JSON, and only CASE fixes the order
  return sql`${col} is null or case when not json_valid(${col}) then 0 when json_type(${col}) <> 'array' then 0 else ${length} between 1 and ${sql.raw(String(values.length))} and ${sql.join([...members, ...distinct], sql` and `)} end`;
};

// a GitHub username, lowercased: 1-39 of a-z, 0-9 and single hyphens, no hyphen at either end
const githubLoginShape = (column: AnySQLiteColumn) =>
  sql`length(${c(column)}) between 1 and 39 and ${c(column)} not glob '*[^a-z0-9-]*' and ${c(column)} not glob '-*' and ${c(column)} not glob '*-' and ${c(column)} not glob '*--*'`;

// an email address, lowercased: 3-254 characters, one @ between a non-empty local part and a
// dotted domain, no whitespace. The full grammar is the API's; this keeps out what would dodge
// the unique index or never be an address
const emailShape = (column: AnySQLiteColumn) =>
  sql`length(${c(column)}) between 3 and 254 and ${c(column)} = lower(${c(column)}) and ${c(column)} glob '?*@?*.?*' and ${c(column)} not glob '*@*@*' and ${c(column)} not glob ('*[' || char(9, 10, 13, 32) || ']*')`;

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
    // lowercased and current as of the last sign-in; access follows github_id, not this
    githubLogin: text("github_login"),
    // a bot's agent id in the system that runs it
    label: text("label"),
    // the address a person let in by email signs in with; such a person has no GitHub account here
    email: text("email"),
    // the human who signed in first as TRAIL_OWNER_GITHUB
    isOwner: integer("is_owner", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    check("actor_kind_check", oneOf(t.kind, actorKinds)),
    check(
      "actor_is_owner_check",
      sql`${c(t.isOwner)} = 0 or (${c(t.isOwner)} = 1 and ${c(t.kind)} = 'human')`,
    ),
    uniqueIndex("actor_owner_unique")
      .on(t.isOwner)
      .where(sql`${c(t.isOwner)} = 1`),
    check("actor_display_name_check", sql`length(${c(t.displayName)}) > 0`),
    check(
      "actor_github_id_check",
      sql`${c(t.kind)} = 'human' or ${c(t.githubId)} is null`,
    ),
    check(
      "actor_github_login_check",
      sql`${c(t.githubLogin)} is null or (${c(t.kind)} = 'human' and ${githubLoginShape(t.githubLogin)})`,
    ),
    uniqueIndex("actor_github_login_unique")
      .on(t.githubLogin)
      .where(sql`${c(t.githubLogin)} is not null`),
    check(
      "actor_email_check",
      sql`${c(t.email)} is null or (${c(t.kind)} = 'human' and ${c(t.githubId)} is null and ${emailShape(t.email)})`,
    ),
    uniqueIndex("actor_email_unique")
      .on(t.email)
      .where(sql`${c(t.email)} is not null`),
    // target of api_key's (actor_id, actor_kind) key, which pins keys to bots
    unique("actor_id_kind_unique").on(t.id, t.kind),
    // lower() folds ASCII only, like nocase: 'Équipe' and 'équipe' are two bots
    uniqueIndex("actor_bot_display_name_lower_unique")
      .on(sql`lower(${c(t.displayName)})`)
      .where(sql`${c(t.kind)} = 'bot'`),
    uniqueIndex("actor_bot_label_unique")
      .on(t.label)
      .where(sql`${c(t.kind)} = 'bot' and ${c(t.label)} is not null`),
  ],
);

// a table of its own, so reading an actor never reads the image bytes
export const actorPhoto = sqliteTable(
  "actor_photo",
  {
    actorId: text("actor_id")
      .primaryKey()
      .references(() => actor.id, { onDelete: "cascade" }),
    contentType: text("content_type", {
      enum: actorPhotoContentTypes,
    }).notNull(),
    // lowercase hex sha256 of content
    hash: text("hash").notNull(),
    updatedAt: updatedAt(),
    // last: a row stores columns in this order, and reading any column after
    // the blob walks its whole overflow-page chain
    content: blob("content", { mode: "buffer" }).notNull(),
  },
  (t) => [
    check(
      "actor_photo_content_type_check",
      oneOf(t.contentType, actorPhotoContentTypes),
    ),
    check(
      "actor_photo_content_check",
      sql`length(${c(t.content)}) between 1 and 262144`,
    ),
    check(
      "actor_photo_hash_check",
      sql`length(${c(t.hash)}) = 64 and ${c(t.hash)} not glob '*[^0-9a-f]*'`,
    ),
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
    // what the key may do; null is every action. Adding an action rewrites the check,
    // a rebuild of this table
    actions: text("actions", { mode: "json" }).$type<ApiKeyAction[]>(),
  },
  (t) => [
    foreignKey({
      columns: [t.actorId, t.actorKind],
      foreignColumns: [actor.id, actor.kind],
    }),
    check("api_key_actor_kind_check", sql`${c(t.actorKind)} = 'bot'`),
    check("api_key_hash_check", sql`length(${c(t.hash)}) = 64`),
    check("api_key_actions_check", jsonSetOf(t.actions, apiKeyActions)),
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
    // the highest issue number in this project, handed out or kept by an import
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

// the projects a key may touch; a key with no rows touches every project
export const apiKeyProject = sqliteTable(
  "api_key_project",
  {
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKey.id, { onDelete: "cascade" }),
    // no cascade: deleting a project must not quietly widen or empty a key's scope.
    // no action, not restrict, which SQLite reports as SQLITE_CONSTRAINT_TRIGGER
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
  },
  (t) => [
    // the key serves "which projects may this key touch"
    primaryKey({ columns: [t.apiKeyId, t.projectId] }),
    index("api_key_project_project_key_idx").on(t.projectId, t.apiKeyId),
  ],
);

/**
 * A person the owner let in, by lowercased GitHub username or by email address:
 * exactly one of the two. A GitHub invite is pending until an account signs in
 * under that username and binds github_id; from then on it is that account's,
 * whatever its login. An email invite belongs to the human actor with that
 * email. Deleting it revokes access and leaves the actor and everything it wrote.
 */
export const invite = sqliteTable(
  "invite",
  {
    // the People API names a person by username or email, never by this
    id: integer("id").primaryKey(),
    username: text("username").unique(),
    email: text("email").unique(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => actor.id),
    // the account that first claimed the username; GitHub frees a username on
    // rename, so access follows this id, not the name. Migration 0007's trigger
    // refuses rewriting it once set; drizzle-kit doesn't see triggers, so a
    // generated rebuild of invite drops it (0012 re-creates it by hand).
    githubId: integer("github_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("invite_username_check", githubLoginShape(t.username)),
    check("invite_email_check", emailShape(t.email)),
    check(
      "invite_kind_check",
      sql`(${c(t.username)} is null) <> (${c(t.email)} is null)`,
    ),
    check(
      "invite_github_id_check",
      sql`${c(t.githubId)} is null or ${c(t.username)} is not null`,
    ),
    uniqueIndex("invite_github_id_unique")
      .on(t.githubId)
      .where(sql`${c(t.githubId)} is not null`),
  ],
);

// the projects an invited person sees; an invite may hold none
export const projectMember = sqliteTable(
  "project_member",
  {
    inviteId: integer("invite_id")
      .notNull()
      .references(() => invite.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    // the key serves "which projects can this invite see"
    primaryKey({ columns: [t.inviteId, t.projectId] }),
    index("project_member_project_invite_idx").on(t.projectId, t.inviteId),
  ],
);

export const issue = sqliteTable(
  "issue",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    // unique within the project, from 1: project.issue_seq + 1 for a new issue, bumped in the same
    // transaction, or the number an import keeps from its source key
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
    // the imported row's workflow-state name in its source system, e.g. "In Review", kept for reference
    sourceStatus: text("source_status"),
    // the imported row's identifier in its source system, uppercased (JUS-187); a lookup alias for the issue
    sourceKey: text("source_key"),
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
      "issue_source_status_check",
      sql`length(${c(t.sourceStatus)}) <= 200`,
    ),
    check(
      "issue_completed_at_check",
      sql`(${oneOf(t.status, completedStatuses)}) = (${c(t.completedAt)} is not null)`,
    ),
    uniqueIndex("issue_project_external_ref_unique")
      .on(t.projectId, t.externalRef)
      .where(sql`${c(t.externalRef)} is not null`),
    uniqueIndex("issue_source_key_unique")
      .on(t.sourceKey)
      .where(sql`${c(t.sourceKey)} is not null`),
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
    // has this actor acted in any of these projects — one probe per bot
    index("activity_event_actor_project_idx").on(t.actorId, t.projectId),
    // one subject's history in order — an issue's timeline
    index("activity_event_subject_seq_idx").on(t.subjectId, t.seq),
  ],
);

export const webhookDeliveryStatuses = [
  "pending",
  "delivered",
  "failed",
] as const;
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatuses)[number];

/**
 * A bot's webhook: an https URL that receives signed POSTs for every activity
 * event of its projects. It belongs to the bot, not to the key that made it, so
 * a key rotation keeps it.
 */
export const webhookSubscription = sqliteTable(
  "webhook_subscription",
  {
    id: id(),
    actorId: text("actor_id")
      .notNull()
      .references(() => actor.id),
    url: text("url").notNull(),
    // the signing secret, AES-256-GCM under a key derived from the server's own secret (webhooks/secret.ts);
    // never the plain secret, and never read back out through the API
    secretCipher: text("secret_cipher").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // set after repeated failures; deliveries wait while it is set, and the bot's update clears it
    pausedAt: integer("paused_at", { mode: "timestamp_ms" }),
    // failed attempts since the last success, across deliveries
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    lastErrorAt: integer("last_error_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    check("webhook_subscription_url_check", sql`length(${c(t.url)}) > 0`),
    check(
      "webhook_subscription_failures_check",
      sql`${c(t.consecutiveFailures)} >= 0`,
    ),
    unique("webhook_subscription_actor_url_unique").on(t.actorId, t.url),
  ],
);

// the projects a subscription follows
export const webhookSubscriptionProject = sqliteTable(
  "webhook_subscription_project",
  {
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => webhookSubscription.id, { onDelete: "cascade" }),
    // no cascade, as on api_key_project: deleting a project must not quietly empty a subscription
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
  },
  (t) => [
    primaryKey({ columns: [t.subscriptionId, t.projectId] }),
    // an event's project finds the subscriptions that follow it
    index("webhook_subscription_project_project_idx").on(
      t.projectId,
      t.subscriptionId,
    ),
  ],
);

/**
 * The outbox: one row per event per subscription, written in the transaction
 * that commits the event, so a restart loses nothing. `id` is the delivery id
 * the receiver sees, the same on every retry.
 */
export const webhookDelivery = sqliteTable(
  "webhook_delivery",
  {
    id: id(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => webhookSubscription.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => activityEvent.id),
    // the event's seq: a subscription's deliveries go out in this order
    seq: integer("seq").notNull(),
    // trail.<action>
    type: text("type").notNull(),
    status: text("status", { enum: webhookDeliveryStatuses })
      .notNull()
      .default("pending"),
    // the JSON sent, built at the first attempt so a retry sends the same bytes
    body: text("body"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", {
      mode: "timestamp_ms",
    }).notNull(),
    lastStatus: integer("last_status"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    check(
      "webhook_delivery_status_check",
      oneOf(t.status, webhookDeliveryStatuses),
    ),
    check("webhook_delivery_attempts_check", sql`${c(t.attempts)} >= 0`),
    unique("webhook_delivery_subscription_event_unique").on(
      t.subscriptionId,
      t.eventId,
    ),
    // the head of a subscription's queue: its oldest pending delivery
    index("webhook_delivery_pending_idx")
      .on(t.subscriptionId, t.seq)
      .where(sql`${c(t.status)} = 'pending'`),
  ],
);

// better-auth's tables, as `npx auth@latest generate` emits them for the drizzle adapter,
// plus the unique github_id. better-auth writes every column itself; a person's identity
// in trail is the actor row, which the sign-in links by github_id.

export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .default(false)
      .notNull(),
    image: text("image"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    // GitHub's numeric user id and lowercased login, refreshed from the profile on every
    // sign-in; both null for a person signed in by email, whose address is `email`
    githubId: integer("github_id").unique(),
    githubLogin: text("github_login"),
  },
  (t) => [
    check(
      "user_github_check",
      sql`(${c(t.githubId)} is null) = (${c(t.githubLogin)} is null)`,
    ),
  ],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
