import type {
  ActivityEventView,
  CommentView,
  IssueView,
  PageView,
  ProjectView,
} from "../../shared/schemas.js";
import type { ActivityEvent } from "../events/bus.js";
import type { Comment, Issue, Page, Project } from "../service/index.js";

// One function per resource, each listing its wire keys, so a new column reaches the wire only on purpose.

export function toProject(row: Project): ProjectView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toIssue(row: Issue): IssueView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    assigneeId: row.assigneeId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toComment(row: Comment): CommentView {
  return {
    id: row.id,
    issueId: row.issueId,
    authorId: row.authorId,
    body: row.body,
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
