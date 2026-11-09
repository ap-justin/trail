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
   * its number when the prefix is the project's key, and is stored (uppercased)
   * so the issue is found by it.
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

/** What the import accepts per row; ordinary creates keep the tighter limits in shared/schemas.ts. */
export const IMPORT_TEXT_MAX = 1024 * 1024;
export const IMPORT_LINKS_MAX = 200;
const STATUS_UPDATE_BODY_MAX = 64 * 1024;
const REF_MAX = 200;
const TITLE_MAX = 300;
const LABELS_MAX = 50;
const LABEL_NAME_MAX = 100;
const LINK_URL_MAX = 2048;

// a source system's timestamps carry an offset or Z
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function instant(value: string, where: string): Date {
  const date = new Date(value);
  if (!timestampPattern.test(value) || Number.isNaN(date.getTime())) {
    throw new ValidationError(
      `${where} is not a timestamp: send ISO 8601 with a Z or offset, like 2026-11-08T09:00:00.000Z`,
    );
  }
  return date;
}

function requireRef(ref: string, where: string): string {
  const trimmed = nonBlank(ref, `${where} externalRef`);
  if (trimmed.length > REF_MAX) {
    throw new ValidationError(
      `${where} externalRef is ${trimmed.length} characters: send the source row's id (Linear's UUID), at most ${REF_MAX}`,
    );
  }
  return trimmed;
}

function atMost(value: string, max: number, what: string): string {
  if (value.length > max) {
    throw new ValidationError(
      `${what} is ${value.length} characters, over the limit of ${max}: shorten it`,
    );
  }
  return value;
}

function sourceAuthorOf(
  value: string | null | undefined,
  where: string,
): string | null | undefined {
  if (value == null) return value;
  return atMost(
    nonBlank(value, `${where} sourceAuthor`),
    REF_MAX,
    `${where} sourceAuthor`,
  );
}

/** Every reason a row of the payload was refused, so one 422 lists them all. */
type Problems = string[];

/**
 * Runs `check`, recording a ValidationError against `where` instead of
 * throwing, so the rest of the payload is still checked.
 */
function attempt<T>(
  problems: Problems,
  where: string,
  check: () => T,
): T | undefined {
  try {
    return check();
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    problems.push(
      error.message.startsWith(where)
        ? error.message
        : `${where}: ${error.message}`,
    );
    return undefined;
  }
}

/** Records a second row with the same externalRef in one scope of the payload. */
function uniqueRefs(
  rows: { externalRef: string }[],
  scope: string,
  problems: Problems,
): void {
  const seen = new Set<string>();
  for (const { externalRef } of rows) {
    if (seen.has(externalRef)) {
      problems.push(
        `${scope} lists externalRef ${externalRef} twice: send each row once, merged into one`,
      );
    }
    seen.add(externalRef);
  }
}

// the rule the schema documents (shared/schemas.ts), checked here with the rest of the row
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

function validImportLabels(names: string[], where: string): string[] {
  if (names.length > LABELS_MAX) {
    throw new ValidationError(
      `${where} lists ${names.length} labels, over the limit of ${LABELS_MAX}: send the ${LABELS_MAX} that matter`,
    );
  }
  for (const name of names) {
    atMost(name.trim(), LABEL_NAME_MAX, `label "${name.slice(0, 20)}…"`);
  }
  return validLabelNames(names);
}

function validImportLinks(links: LinkInput[], where: string): Link[] {
  if (links.length > IMPORT_LINKS_MAX) {
    throw new ValidationError(
      `${where} lists ${links.length} links, over the limit of ${IMPORT_LINKS_MAX}: send the ${IMPORT_LINKS_MAX} that matter`,
    );
  }
  for (const link of links) {
    const url = link.url.trim();
    let scheme = "";
    try {
      scheme = new URL(url).protocol;
    } catch {
      // reported below with the url
    }
    if (
      (scheme !== "http:" && scheme !== "https:") ||
      url.length > LINK_URL_MAX
    ) {
      throw new ValidationError(
        `${where} has the link url "${url.slice(0, 60)}", which is not an http or https url of at most ${LINK_URL_MAX} characters: fix it or drop that link`,
      );
    }
    if (link.title !== undefined) {
      atMost(link.title.trim(), TITLE_MAX, `${where} link title`);
    }
  }
  return validLinks(links);
}

function normalComment(
  row: ImportComment,
  where: string,
  problems: Problems,
  bodyMax = IMPORT_TEXT_MAX,
): NormalComment | undefined {
  const before = problems.length;
  const body = attempt(problems, where, () => {
    if (row.body.trim() === "") {
      throw new ValidationError(`${where} body must not be empty`);
    }
    return atMost(row.body, bodyMax, `${where} body`);
  });
  const externalRef = attempt(problems, where, () =>
    requireRef(row.externalRef, where),
  );
  const createdAt = attempt(problems, where, () =>
    instant(row.createdAt, `${where} createdAt`),
  );
  const sourceAuthor = attempt(problems, where, () =>
    sourceAuthorOf(row.sourceAuthor, where),
  );
  if (problems.length > before) return undefined;
  return {
    externalRef: externalRef as string,
    body: body as string,
    createdAt: createdAt as Date,
    sourceAuthor,
  };
}

/** How a row is named in an error: its source key and externalRef, whichever it sent. */
function rowName(
  kind: string,
  row: { externalRef?: unknown; sourceKey?: unknown },
  index: number,
): string {
  const ref = typeof row.externalRef === "string" ? row.externalRef.trim() : "";
  const key = typeof row.sourceKey === "string" ? row.sourceKey.trim() : "";
  if (ref === "") return `${kind} #${index + 1}${key ? ` (${key})` : ""}`;
  return key ? `${kind} ${key} (externalRef ${ref})` : `${kind} ${ref}`;
}

function normalIssue(
  row: ImportIssue,
  index: number,
  problems: Problems,
): NormalIssue | undefined {
  const where = rowName("issue", row, index);
  const before = problems.length;
  const check = <T>(run: () => T) => attempt(problems, where, run);
  const externalRef = check(() => requireRef(row.externalRef, where));
  const status = check(() => mapStatus(row, where));
  const sourceStatus = check(() =>
    row.status === undefined
      ? null
      : atMost(
          nonBlank(row.status, `${where} status`),
          REF_MAX,
          `${where} status`,
        ),
  );
  if (status !== undefined && row.completedAt != null && !isClosed(status)) {
    problems.push(
      `${where} is ${status} (from "${row.statusType ?? row.status}") but has a completedAt: send completedAt only on a done or canceled issue, or null`,
    );
  }
  const comments: NormalComment[] = [];
  for (const [i, c] of (row.comments ?? []).entries()) {
    const normal = normalComment(
      c,
      `${rowName("comment", c, i)} of ${where}`,
      problems,
    );
    if (normal) comments.push(normal);
  }
  uniqueRefs(comments, `${where} comments`, problems);
  const sourceKey = check(() => validSourceKey(row.sourceKey, where));
  const title = check(() =>
    atMost(nonBlank(row.title, `${where} title`), TITLE_MAX, `${where} title`),
  );
  const description = check(() =>
    row.description === undefined
      ? undefined
      : atMost(row.description, IMPORT_TEXT_MAX, `${where} description`),
  );
  const priority = check(() => validPriority(row.priority));
  const estimate = check(() => validEstimate(row.estimate));
  const labels = check(() =>
    row.labels === undefined ? undefined : validImportLabels(row.labels, where),
  );
  const links = check(() =>
    row.links === undefined ? undefined : validImportLinks(row.links, where),
  );
  const createdAt = check(() => instant(row.createdAt, `${where} createdAt`));
  const completedAt = check(() =>
    row.completedAt == null
      ? undefined
      : instant(row.completedAt, `${where} completedAt`),
  );
  const sourceAuthor = check(() => sourceAuthorOf(row.sourceAuthor, where));
  if (problems.length > before) return undefined;
  return {
    externalRef: externalRef as string,
    sourceKey,
    title: title as string,
    description,
    status: status as IssueStatus,
    sourceStatus: sourceStatus as string | null,
    priority,
    estimate,
    labels,
    links,
    createdAt: createdAt as Date,
    completedAt,
    sourceAuthor,
    comments,
  };
}

/**
 * The payload checked and normalised before the database is touched. Every
 * row that fails is reported in the one ValidationError, so the bot fixes
 * them in a single pass; nothing is written either way.
 */
export function normalImport(payload: ImportPayload): NormalImport {
  const problems: Problems = [];
  const rows = payload.issues ?? [];
  const issues = rows
    .map((row, i) => normalIssue(row, i, problems))
    .filter((row): row is NormalIssue => row !== undefined);
  uniqueRefs(issues, "issues", problems);
  const sourceKeys = new Map<string, string>();
  for (const row of issues) {
    if (row.sourceKey === undefined) continue;
    const twin = sourceKeys.get(row.sourceKey);
    if (twin !== undefined) {
      problems.push(
        `issues ${twin} and ${row.externalRef} both send sourceKey ${row.sourceKey}: a source key names one issue, so send each issue its own Linear identifier`,
      );
    }
    sourceKeys.set(row.sourceKey, row.externalRef);
  }
  const statusUpdates: NormalStatusUpdate[] = [];
  for (const [i, u] of (payload.statusUpdates ?? []).entries()) {
    const where = rowName("status update", u, i);
    const normal = normalComment(u, where, problems, STATUS_UPDATE_BODY_MAX);
    const health = attempt(problems, where, () => validHealth(u.health));
    if (normal && health) statusUpdates.push({ ...normal, health });
  }
  uniqueRefs(statusUpdates, "statusUpdates", problems);
  const project = (run: () => unknown) => attempt(problems, "project", run);
  const externalRef = project(() => requireRef(payload.externalRef, "project"));
  const key = project(() => validProjectKey(payload.key));
  const name = project(() => nonBlank(payload.name, "name"));
  const createdAt = project(() =>
    payload.createdAt === undefined
      ? undefined
      : instant(payload.createdAt, "project createdAt"),
  );
  const labels = project(() =>
    validLabelNames([
      ...(payload.labels ?? []),
      ...issues.flatMap((i) => i.labels ?? []),
    ]),
  );
  if (problems.length > 0) {
    throw new ValidationError(
      problems.length === 1
        ? `${problems[0]}. Nothing was imported: fix it and send the whole import again`
        : `${problems.length} import problems, listed below. Nothing was imported: fix every one and send the whole import again.\n${problems.map((p) => `- ${p}`).join("\n")}`,
    );
  }
  return {
    externalRef: externalRef as string,
    key: key as string,
    name: name as string,
    description: payload.description,
    createdAt: createdAt as Date | undefined,
    labels: labels as string[],
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
