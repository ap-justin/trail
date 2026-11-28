import type {
  ActivityEventView,
  ActorView,
  BotView,
  CommentView,
  CreatedCommentView,
  ImportResultView,
  InboxEntryView,
  IssueView,
  LabelView,
  MarkReadResultView,
  MessageView,
  NamedProductView,
  PageView,
  ProductView,
  ProjectView,
  SentMessageView,
  StatusUpdateView,
  WebhookView,
  WhoamiView,
} from "../../shared/schemas.js";
import type {
  ActivityEntry,
  Actor,
  Bot,
  Comment,
  ImportResult,
  Issue,
  Label,
  MarkReadResult,
  Message,
  NamedProduct,
  NoteCounts,
  Page,
  ProductView as Product,
  ProductDetail,
  ProjectView as Project,
  SentMessage,
  StatusUpdate,
  Webhook,
  Whoami,
} from "../service/index.js";
import { isNoteStatus } from "../service/index.js";
import { type KeyScope, scopeView } from "../service/keys.js";
import { MESSAGE_PREVIEW_CHARS } from "../service/messages.js";
import { buildLogHint, type Surface } from "./build-log.js";

// One function per resource, each listing its wire keys, so a new column reaches the wire only on purpose.

/** A product; with `notes` as get_product reads it. */
export function toProduct(row: Product & { notes?: NoteCounts }): ProductView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    description: row.description,
    repoUrl: row.repoUrl,
    owner: row.owner,
    externalRef: row.externalRef,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.notes && { notes: row.notes }),
  };
}

/** A product as a key reads it: `toProduct`, with `notes` from get_product, or for one named only through a project its id, key and name. */
export function toProductRead(
  row: ProductDetail | Product | NamedProduct,
): ProductView | NamedProductView {
  return "createdBy" in row
    ? toProduct(row)
    : { id: row.id, key: row.key, name: row.name };
}

export function toProject(row: Project): ProjectView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    goal: row.goal,
    lead: row.lead,
    targetDate: row.targetDate,
    products: row.products.map((p) => ({ key: p.key, name: p.name })),
    hiddenProducts: row.hiddenProducts,
    counts: row.counts,
    notes: row.notes,
    latestStatusUpdate:
      row.latestStatusUpdate === null
        ? null
        : {
            ...toStatusUpdate(row.latestStatusUpdate),
            author: row.latestStatusUpdate.author,
          },
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.progress && { progress: row.progress }),
  };
}

/** A link as an item shows it: pr only on a pull request link. */
export function toLink(l: Issue["links"][number]): IssueView["links"][number] {
  return {
    url: l.url,
    title: l.title,
    ...(l.pr !== undefined && {
      pr: l.pr && {
        state: l.pr.state,
        checkedAt: l.pr.checkedAt.toISOString(),
      },
    }),
  };
}

export function toIssue(row: Issue): IssueView {
  return {
    id: row.id,
    key: row.key,
    number: row.number,
    type: row.type,
    product: row.productKey,
    project: row.productKey,
    projects: row.projects,
    sourceKey: row.sourceKey,
    projectId: row.productId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    estimate: row.estimate,
    labels: row.labels,
    links: row.links.map(toLink),
    assignee: row.assignee,
    assigneeId: row.assigneeId,
    filedFor: row.filedFor,
    externalRef: row.externalRef,
    sourceAuthor: row.sourceAuthor,
    sourceStatus: row.sourceStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    ...(row.access && { access: row.access }),
    ...(row.about && { about: row.about }),
    ...(row.notes && { notes: row.notes }),
    ...(row.notesCount && { notesCount: row.notesCount }),
  };
}

/** An item as the routes from before triage serve it: triage, which their status enum lacks, reads as open. */
export function toLegacyIssue(row: Issue) {
  return {
    ...toIssue(row),
    type: legacyType(row.type),
    status: legacyStatus(row.status),
  };
}

// the service keeps notes from reaching the legacy routes
function legacyType(type: Issue["type"]) {
  if (type === "note") throw new Error("a note reached a legacy route");
  return type;
}

function legacyStatus(status: Issue["status"]) {
  if (status === "triage") return "open";
  if (isNoteStatus(status)) {
    throw new Error(`a note, in status ${status}, reached a legacy route`);
  }
  return status;
}

/** A created item's view with the label names left off it, when a filer outside the product sent some the product lacks. */
export const withSkippedLabels = <T extends object>(
  view: T,
  row: { skippedLabels?: string[] },
) =>
  row.skippedLabels === undefined
    ? view
    : { ...view, skippedLabels: row.skippedLabels };

/** `view` with the note naming what replaces the deprecated call that produced it. */
export const deprecated = <T extends object>(view: T, note: string) => ({
  ...view,
  deprecated: note,
});

export function toComment(row: Comment): CommentView {
  return {
    id: row.id,
    issueId: row.issueId,
    authorId: row.authorId,
    body: row.body,
    externalRef: row.externalRef,
    sourceAuthor: row.sourceAuthor,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A comment as its create answers it: with hint when its body reads like a build log. */
export function toCreatedComment(
  row: Comment,
  surface: Surface,
): CreatedCommentView {
  const hint = buildLogHint(row.body, surface);
  return hint === undefined ? toComment(row) : { ...toComment(row), hint };
}

export function toStatusUpdate(row: StatusUpdate): StatusUpdateView {
  return {
    id: row.id,
    product: row.productKey,
    project: row.projectSlug,
    projectId: row.productId,
    authorId: row.authorId,
    body: row.body,
    health: row.health,
    externalRef: row.externalRef,
    sourceAuthor: row.sourceAuthor,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toLabel(row: Label): LabelView {
  return {
    id: row.id,
    projectId: row.productId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toActivityEvent(row: ActivityEntry): ActivityEventView {
  return {
    id: row.id,
    actorId: row.actorId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    product: row.productKey,
    projectSlug: row.projectSlug,
    projectId: row.productId,
    action: row.action,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toActor(row: Actor): ActorView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.displayName,
    label: row.label,
  };
}

export function toWhoami(row: Whoami, scope: KeyScope): WhoamiView {
  const ref = (p: { key: string; name: string }) => ({
    key: p.key,
    name: p.name,
  });
  return {
    ...toActor(row),
    scope: scopeView(scope),
    ownProducts: row.ownProducts.map(ref),
    products: row.products.map(ref),
    impliedProjects: row.impliedProjects,
    photoUrl: row.photoUrl,
    title: row.title,
    unreadMessages: row.unreadMessages,
    team: row.team && ref(row.team),
    ...(row.hint !== undefined && { hint: row.hint }),
    handler: row.handler && {
      name: row.handler.name,
      email: row.handler.email,
    },
  };
}

export function toBot(row: Bot): BotView {
  return {
    id: row.id,
    name: row.displayName,
    label: row.label,
    photoUrl: row.photoUrl,
    title: row.title,
    handler: row.handler,
  };
}

export function toPage<T, V>(page: Page<T>, view: (row: T) => V): PageView<V> {
  return { items: page.items.map(view), nextCursor: page.nextCursor };
}

export function toImportResult(result: ImportResult): ImportResultView {
  // the service counts products under projects, the name its stored events carry
  const counts = (n: ImportResult["created"]) => ({
    ...n,
    products: n.projects,
  });
  return {
    product: toProduct(result.product),
    project: toProduct(result.product),
    renumbered: result.renumbered,
    created: counts(result.created),
    updated: counts(result.updated),
    unchanged: counts(result.unchanged),
  };
}

export function toWebhook(row: Webhook): WebhookView {
  return {
    id: row.id,
    kind: row.kind,
    url: row.url,
    products: row.products,
    projects: row.projects,
    paused: row.pausedAt !== null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMessage(row: Message): MessageView {
  return {
    id: row.id,
    from: { id: row.from.id, name: row.from.name },
    to: { id: row.to.id, name: row.to.name },
    threadId: row.threadId,
    replyTo: row.replyToId,
    expectsReply: row.expectsReply,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

export function toSentMessage(row: SentMessage): SentMessageView {
  return {
    message: toMessage(row.message),
    thread: { id: row.thread.id, messageCount: row.thread.messageCount },
  };
}

/** A message text's first characters, and whether there is more. */
export function previewOf(text: string) {
  // by code point, so a preview never ends on half a surrogate pair
  const chars = [...text];
  return {
    preview: chars.slice(0, MESSAGE_PREVIEW_CHARS).join(""),
    truncated: chars.length > MESSAGE_PREVIEW_CHARS,
  };
}

export function toInboxEntry(row: Message): InboxEntryView {
  return {
    id: row.id,
    from: { id: row.from.id, name: row.from.name },
    threadId: row.threadId,
    replyTo: row.replyToId,
    expectsReply: row.expectsReply,
    ...previewOf(row.text),
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

export function toMarkReadResult(row: MarkReadResult): MarkReadResultView {
  return {
    results: row.results.map((r) => ({
      id: r.id,
      result: r.result,
      readAt: r.readAt?.toISOString() ?? null,
    })),
    unreadMessages: row.unreadMessages,
  };
}
