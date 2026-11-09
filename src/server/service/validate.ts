import {
  type IssueStatus,
  issueStatuses,
  type ProjectHealth,
  projectHealths,
} from "../db/schema.js";
import { ValidationError } from "./errors.js";

export type Link = { url: string; title: string };
export type LinkInput = { url: string; title?: string };

const projectKeyPattern = /^[A-Z0-9]{2,10}$/;

/** Per-issue set sizes outside an import; the schema caps a full replace, `withinIssueCap` the merged add form. */
export const ISSUE_LABELS_MAX = 50;
export const ISSUE_LINKS_MAX = 50;

export function withinIssueCap<T>(set: T[], what: "labels" | "links"): T[] {
  const [max, remove] =
    what === "labels"
      ? [ISSUE_LABELS_MAX, "removeLabels"]
      : [ISSUE_LINKS_MAX, "removeLinks"];
  if (set.length > max) {
    throw new ValidationError(
      `the issue would have ${set.length} ${what}, over the limit of ${max}: remove some with ${remove} in the same patch`,
    );
  }
  return set;
}

export function nonBlank(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new ValidationError(`${field} must not be empty`);
  return trimmed;
}

export function validStatus(status: string): IssueStatus {
  if (!(issueStatuses as readonly string[]).includes(status)) {
    throw new ValidationError(
      `status must be one of ${issueStatuses.join(", ")}`,
    );
  }
  return status as IssueStatus;
}

export function validHealth(health: string): ProjectHealth {
  if (!(projectHealths as readonly string[]).includes(health)) {
    throw new ValidationError(
      `health must be one of ${projectHealths.join(", ")}`,
    );
  }
  return health as ProjectHealth;
}

export function validProjectKey(raw: string): string {
  const key = raw.trim().toUpperCase();
  if (!projectKeyPattern.test(key)) {
    throw new ValidationError(
      `key must be 2 to 10 letters A-Z or digits, like TRL; got "${raw}"`,
    );
  }
  return key;
}

export function validPriority(
  priority: number | undefined,
): number | undefined {
  if (priority === undefined) return undefined;
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new ValidationError(
      "priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low)",
    );
  }
  return priority;
}

export function validEstimate(
  estimate: number | null | undefined,
): number | null | undefined {
  if (estimate == null) return estimate;
  if (!Number.isFinite(estimate) || estimate < 0) {
    throw new ValidationError("estimate must be a number of hours, 0 or more");
  }
  return estimate;
}

export function optionalRef(ref: string | null | undefined): string | null {
  return ref == null ? null : nonBlank(ref, "externalRef");
}

/**
 * A label name as the labels unique index compares it: SQLite's nocase folds
 * A-Z only, so "Foo" and "foo" are one label and "Équipe" and "équipe" two.
 */
export const labelKey = (name: string) =>
  name.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Trimmed names, a repeat (in ASCII case, see `labelKey`) dropped. */
export function validLabelNames(names: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of names) {
    const name = nonBlank(raw, "label name");
    if (!seen.has(labelKey(name))) seen.set(labelKey(name), name);
  }
  return [...seen.values()];
}

export function validLinks(links: LinkInput[]): Link[] {
  const urls = new Set<string>();
  return links.map((link) => {
    const url = nonBlank(link.url, "link url");
    if (urls.has(url)) {
      throw new ValidationError(`links lists ${url} twice: send each url once`);
    }
    urls.add(url);
    const title = link.title === undefined ? "" : link.title.trim();
    return { url, title: title === "" ? url : title };
  });
}

export const isClosed = (status: IssueStatus) =>
  status === "done" || status === "canceled";

/** When an issue in `status` was completed: kept while it stays closed, `now` once it closes, null while open. */
export function completedAtOf(
  status: IssueStatus,
  current: Date | null,
  now: Date,
): Date | null {
  return isClosed(status) ? (current ?? now) : null;
}
