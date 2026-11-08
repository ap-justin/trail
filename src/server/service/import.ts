import type { IssueStatus, ProjectHealth } from "../db/schema.js";
import { ValidationError } from "./errors.js";
import {
  isClosed,
  type Link,
  type LinkInput,
  nonBlank,
  validEstimate,
  validHealth,
  validLabelNames,
  validLinks,
  validPriority,
  validProjectKey,
} from "./validate.js";

/**
 * One project as another tracker holds it, each row keyed by its id there
 * (`externalRef`). Timestamps are ISO 8601. A field left out of a row that
 * already exists is left as it is.
 */
export type ImportPayload = {
  externalRef: string;
  key: string;
  name: string;
  description?: string;
  createdAt?: string;
  /** Label names; a name on an issue is created too. */
  labels?: string[];
  issues?: ImportIssue[];
  statusUpdates?: ImportStatusUpdate[];
};
export type ImportIssue = {
  externalRef: string;
  /**
   * The source's human key (Linear's identifier, JUS-187). A new issue keeps
   * its number when the prefix is the project's key; not stored.
   */
  sourceKey?: string;
  title: string;
  description?: string;
  /**
   * The source state's name, kept as `sourceStatus` (cleared when left out).
   * Without `statusType` it decides the status (see `sourceStatuses`); one of
   * the two is required.
   */
  status?: string;
  /** The source state's type (see `sourceStatusTypes`), deciding the status when sent. */
  statusType?: string;
  priority?: number;
  estimate?: number | null;
  /** Replaces the issue's labels. */
  labels?: string[];
  /** Replaces the issue's links. */
  links?: LinkInput[];
  createdAt: string;
  /** Only on a done or canceled issue; one closed without it is stamped when first imported. */
  completedAt?: string | null;
  sourceAuthor?: string | null;
  comments?: ImportComment[];
};
export type ImportComment = {
  externalRef: string;
  body: string;
  createdAt: string;
  sourceAuthor?: string | null;
};
export type ImportStatusUpdate = {
  externalRef: string;
  body: string;
  health: ProjectHealth;
  createdAt: string;
  sourceAuthor?: string | null;
};

export type ImportCounts = {
  projects: number;
  issues: number;
  comments: number;
  labels: number;
  links: number;
  statusUpdates: number;
};

// Linear's default workflow states, matched in any case, then trail's own statuses
const sourceStatuses: Record<string, IssueStatus> = {
  backlog: "open",
  todo: "open",
  triage: "open",
  "in progress": "in_progress",
  done: "done",
  canceled: "canceled",
  duplicate: "canceled",
  open: "open",
  in_progress: "in_progress",
};

/** Linear's fixed workflow state types (`state.type`). */
export const sourceStateTypes = [
  "backlog",
  "unstarted",
  "triage",
  "started",
  "completed",
  "canceled",
  "duplicate",
] as const;

// matched in any case
const sourceStatusTypes: Record<string, IssueStatus> = {
  backlog: "open",
  unstarted: "open",
  triage: "open",
  started: "in_progress",
  completed: "done",
  canceled: "canceled",
  duplicate: "canceled",
} satisfies Record<(typeof sourceStateTypes)[number], IssueStatus>;

export type NormalIssue = {
  externalRef: string;
  /** Uppercased. */
  sourceKey: string | undefined;
  title: string;
  description: string | undefined;
  status: IssueStatus;
  sourceStatus: string | null;
  priority: number | undefined;
  estimate: number | null | undefined;
  labels: string[] | undefined;
  links: Link[] | undefined;
  createdAt: Date;
  completedAt: Date | undefined;
  sourceAuthor: string | null | undefined;
  comments: NormalComment[];
};
export type NormalComment = {
  externalRef: string;
  body: string;
  createdAt: Date;
  sourceAuthor: string | null | undefined;
};
export type NormalStatusUpdate = NormalComment & { health: ProjectHealth };
export type NormalImport = {
  externalRef: string;
  key: string;
  name: string;
  description: string | undefined;
  createdAt: Date | undefined;
  labels: string[];
  issues: NormalIssue[];
  statusUpdates: NormalStatusUpdate[];
};

function mapStatus(
  row: Pick<ImportIssue, "status" | "statusType">,
  where: string,
): IssueStatus {
  if (row.statusType !== undefined) {
    const mapped = sourceStatusTypes[row.statusType.trim().toLowerCase()];
    if (mapped === undefined) {
      throw new ValidationError(
        `${where}: statusType "${row.statusType}" is not a state type: send one of ${sourceStateTypes.join(", ")} (any case), Linear's state.type`,
      );
    }
    return mapped;
  }
  if (row.status === undefined) {
    throw new ValidationError(
      `${where} has neither status nor statusType: send statusType (Linear's state.type, like started) and status (the state's name, like In Review)`,
    );
  }
  const mapped = sourceStatuses[row.status.trim().toLowerCase()];
  if (mapped === undefined) {
    throw new ValidationError(
      `${where}: status "${row.status}" has no mapping: send statusType too (Linear's state.type: ${sourceStateTypes.join(", ")}), or a status of Backlog, Todo, Triage, In Progress, Done, Canceled, Duplicate (any case) or a trail status: open, in_progress, done, canceled`,
    );
  }
  return mapped;
}

function instant(value: string, where: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(
      `${where} is not a timestamp: send ISO 8601, like 2026-11-08T09:00:00.000Z`,
    );
  }
  return date;
}

function requireRef(ref: string, where: string): string {
  return nonBlank(ref, `${where} externalRef`);
}

/** Refuses a second row with the same externalRef in one scope of the payload. */
function uniqueRefs(rows: { externalRef: string }[], scope: string): void {
  const seen = new Set<string>();
  for (const { externalRef } of rows) {
    if (seen.has(externalRef)) {
      throw new ValidationError(
        `${scope} lists externalRef ${externalRef} twice: send each row once, merged into one`,
      );
    }
    seen.add(externalRef);
  }
}

// the schema's sourceKey rule (shared/schemas.ts), for callers that skip it
const sourceKeyPattern = /^[A-Za-z0-9]{2,10}-[1-9]\d*$/;

function validSourceKey(
  raw: string | undefined,
  where: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const key = raw.trim();
  if (!sourceKeyPattern.test(key)) {
    throw new ValidationError(
      `${where}: sourceKey "${raw}" is not an issue key: send Linear's identifier, like JUS-187`,
    );
  }
  return key.toUpperCase();
}

function normalComment(row: ImportComment, where: string): NormalComment {
  if (row.body.trim() === "") {
    throw new ValidationError(`${where} body must not be empty`);
  }
  return {
    externalRef: requireRef(row.externalRef, where),
    body: row.body,
    createdAt: instant(row.createdAt, `${where} createdAt`),
    sourceAuthor: row.sourceAuthor,
  };
}

function normalIssue(row: ImportIssue): NormalIssue {
  const externalRef = requireRef(row.externalRef, "issue");
  const where = `issue ${externalRef}`;
  const status = mapStatus(row, where);
  const sourceStatus =
    row.status === undefined ? null : nonBlank(row.status, `${where} status`);
  if (row.completedAt != null && !isClosed(status)) {
    throw new ValidationError(
      `${where} is ${status} (from "${row.statusType ?? row.status}") but has a completedAt: send completedAt only on a done or canceled issue, or null`,
    );
  }
  const comments = (row.comments ?? []).map((c) =>
    normalComment(c, `comment ${c.externalRef} of ${where}`),
  );
  uniqueRefs(comments, `${where} comments`);
  return {
    externalRef,
    sourceKey: validSourceKey(row.sourceKey, where),
    title: nonBlank(row.title, `${where} title`),
    description: row.description,
    status,
    sourceStatus,
    priority: validPriority(row.priority),
    estimate: validEstimate(row.estimate),
    labels: row.labels === undefined ? undefined : validLabelNames(row.labels),
    links: row.links === undefined ? undefined : validLinks(row.links),
    createdAt: instant(row.createdAt, `${where} createdAt`),
    completedAt:
      row.completedAt == null
        ? undefined
        : instant(row.completedAt, `${where} completedAt`),
    sourceAuthor: row.sourceAuthor,
    comments,
  };
}

/** The payload checked and normalised before the database is touched. */
export function normalImport(payload: ImportPayload): NormalImport {
  const issues = (payload.issues ?? []).map(normalIssue);
  uniqueRefs(issues, "issues");
  const statusUpdates = (payload.statusUpdates ?? []).map((u) => ({
    ...normalComment(u, `status update ${u.externalRef}`),
    health: validHealth(u.health),
  }));
  uniqueRefs(statusUpdates, "statusUpdates");
  return {
    externalRef: requireRef(payload.externalRef, "project"),
    key: validProjectKey(payload.key),
    name: nonBlank(payload.name, "name"),
    description: payload.description,
    createdAt:
      payload.createdAt === undefined
        ? undefined
        : instant(payload.createdAt, "project createdAt"),
    labels: validLabelNames([
      ...(payload.labels ?? []),
      ...issues.flatMap((i) => i.labels ?? []),
    ]),
    issues,
    statusUpdates,
  };
}

export const zeroCounts = (): ImportCounts => ({
  projects: 0,
  issues: 0,
  comments: 0,
  labels: 0,
  links: 0,
  statusUpdates: 0,
});
