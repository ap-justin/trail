import type {
  ActivityEventView,
  ActorView,
  BotView,
  CommentView,
  ImportResultView,
  IssueView,
  LabelView,
  PageView,
  ProductView,
  ProjectView,
  StatusUpdateView,
  WebhookView,
  WhoamiView,
} from "../../shared/schemas.js";
import type {
  ActivityEntry,
  Actor,
  ActorWithPhoto,
  Comment,
  ImportResult,
  Issue,
  Label,
  Page,
  ProductView as Product,
  ProjectView as Project,
  StatusUpdate,
  Webhook,
  Whoami,
} from "../service/index.js";
import type { KeyScope } from "../service/keys.js";

// One function per resource, each listing its wire keys, so a new column reaches the wire only on purpose.

export function toProduct(row: Product): ProductView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    repoUrl: row.repoUrl,
    owner: row.owner,
    externalRef: row.externalRef,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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
    links: row.links.map((l) => ({ url: l.url, title: l.title })),
    assignee: row.assignee,
    assigneeId: row.assigneeId,
    externalRef: row.externalRef,
    sourceAuthor: row.sourceAuthor,
    sourceStatus: row.sourceStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** An item as the routes from before triage serve it: triage, which their status enum lacks, reads as open. */
export function toLegacyIssue(row: Issue) {
  const view = toIssue(row);
  return {
    ...view,
    status: view.status === "triage" ? ("open" as const) : view.status,
  };
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
  const products = scope.products?.map((p) => p.key) ?? null;
  const ref = (p: { key: string; name: string }) => ({
    key: p.key,
    name: p.name,
  });
  return {
    ...toActor(row),
    scope: { products, projects: products, actions: scope.actions },
    ownProducts: row.ownProducts.map(ref),
    products: row.products.map(ref),
    photoUrl: row.photoUrl,
    title: row.title,
  };
}

export function toBot(row: ActorWithPhoto): BotView {
  return {
    id: row.id,
    name: row.displayName,
    label: row.label,
    photoUrl: row.photoUrl,
    title: row.title,
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
    url: row.url,
    products: row.products,
    projects: row.products,
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
