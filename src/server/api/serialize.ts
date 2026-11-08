import type {
  ActivityEventView,
  CommentView,
  ImportResultView,
  IssueView,
  LabelView,
  PageView,
  ProjectView,
  StatusUpdateView,
} from "../../shared/schemas.js";
import type { ActivityEvent } from "../events/bus.js";
import type {
  Comment,
  ImportResult,
  Issue,
  Label,
  Page,
  Project,
  StatusUpdate,
} from "../service/index.js";

// One function per resource, each listing its wire keys, so a new column reaches the wire only on purpose.

export function toProject(row: Project): ProjectView {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    externalRef: row.externalRef,
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
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    estimate: row.estimate,
    labels: row.labels,
    links: row.links.map((l) => ({ url: l.url, title: l.title })),
    assigneeId: row.assigneeId,
    externalRef: row.externalRef,
    sourceAuthor: row.sourceAuthor,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

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
    projectId: row.projectId,
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
    projectId: row.projectId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toActivityEvent(row: ActivityEvent): ActivityEventView {
  return {
    id: row.id,
    actorId: row.actorId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    projectId: row.projectId,
    action: row.action,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPage<T, V>(page: Page<T>, view: (row: T) => V): PageView<V> {
  return { items: page.items.map(view), nextCursor: page.nextCursor };
}

export function toImportResult(result: ImportResult): ImportResultView {
  return {
    project: toProject(result.project),
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
  };
}
