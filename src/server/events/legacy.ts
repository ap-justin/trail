import type { ActivitySubjectType } from "../db/schema.js";

// Products are stored as products, but the API, MCP tools and webhooks still call them projects:
// these map a stored event to the names those surfaces publish.

/** The subject types the public surfaces publish: a product goes out as "project". */
export const legacySubjectTypes = [
  "project",
  "issue",
  "comment",
  "label",
  "status_update",
] as const satisfies readonly ActivitySubjectType[];
export type LegacySubjectType = (typeof legacySubjectTypes)[number];

export const legacySubjectType = (
  type: ActivitySubjectType,
): LegacySubjectType => (type === "product" ? "project" : type);

/** `product.created` goes out as `project.created`; every other action as stored. */
export const legacyAction = (action: string): string =>
  action.startsWith("product.")
    ? `project.${action.slice("product.".length)}`
    : action;
