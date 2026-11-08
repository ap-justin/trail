import { z } from "@hono/zod-openapi";
import {
  activitySubjectTypes,
  issueStatuses,
  projectHealths,
} from "../server/db/schema.js";

const issueStatusSchema = z.enum(issueStatuses).openapi("IssueStatus");
const healthSchema = z.enum(projectHealths).openapi("ProjectHealth");
const priority = z.int().min(0).max(4).openapi({
  description: "0 none, 1 urgent, 2 high, 3 medium, 4 low.",
});
const estimate = z.number().min(0).openapi({ description: "Hours." });
const externalRef = z.string().min(1).max(200).openapi({
  description:
    "The row's id in the system it came from, like JUS-167; unique within its scope, so a second create with it is a 409.",
  example: "JUS-167",
});
const labelName = z.string().min(1).max(100);
const linkSchema = z
  .object({ url: z.string(), title: z.string() })
  .openapi("Link");

const id = z.string().min(1);
const timestamp = z.iso
  .datetime()
  .openapi({ example: "2026-11-08T09:00:00.000Z" });

export const errorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "not_found" }),
      message: z.string(),
    }),
  })
  .openapi("Error");

export const projectSchema = z
  .object({
    id,
    key: z.string().openapi({ example: "TRL" }),
    name: z.string(),
    description: z.string(),
    externalRef: z.string().nullable(),
    createdBy: id,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi("Project");

export const issueSchema = z
  .object({
    id,
    key: z.string().openapi({
      description: "The project's key and the issue's number.",
      example: "TRL-12",
    }),
    number: z.int().openapi({ example: 12 }),
    projectId: id,
    title: z.string(),
    description: z.string(),
    status: issueStatusSchema,
    priority,
    estimate: estimate.nullable(),
    labels: z.array(z.string()).openapi({ description: "Names, A to Z." }),
    links: z.array(linkSchema),
    assigneeId: id.nullable(),
    externalRef: z.string().nullable(),
    createdBy: id,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi("Issue");

export const commentSchema = z
  .object({
    id,
    issueId: id,
    authorId: id,
    body: z.string(),
    externalRef: z.string().nullable(),
    createdAt: timestamp,
  })
  .openapi("Comment");

export const statusUpdateSchema = z
  .object({
    id,
    projectId: id,
    authorId: id,
    body: z.string(),
    health: healthSchema,
    externalRef: z.string().nullable(),
    createdAt: timestamp,
  })
  .openapi("StatusUpdate");

export const labelSchema = z
  .object({ id, projectId: id, name: z.string(), createdAt: timestamp })
  .openapi("Label");

export const activityEventSchema = z
  .object({
    id,
    actorId: id,
    subjectType: z.enum(activitySubjectTypes),
    subjectId: id,
    projectId: id.nullable(),
    action: z.string().openapi({ example: "issue.updated" }),
    payload: z.record(z.string(), z.unknown()),
    createdAt: timestamp,
  })
  .openapi("ActivityEvent");

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().openapi({
      description: "Pass as `cursor` for the next page; null on the last.",
    }),
  });
}

const name = z.string().min(1).max(200);
const title = z.string().min(1).max(300);
// counted in UTF-16 units, so at most 192 KiB of UTF-8: room under MAX_BODY_BYTES (server/api/routes.ts)
const text = z.string().max(64 * 1024);

// Strict, so a misspelled field is a 422 rather than a write that silently skips it.
const projectRef = id.openapi({
  description: "The project's id or its key, like TRL.",
});
const labelNames = z.array(labelName).max(50).openapi({
  description:
    "Label names. A name matches the project's label in any case; a new name creates the label.",
});
const links = z
  .array(
    z.strictObject({
      url: z.url().max(2048),
      title: z
        .string()
        .max(300)
        .optional()
        .openapi({ description: "Defaults to the url." }),
    }),
  )
  .max(50);

export const projectCreateSchema = z
  .strictObject({
    name,
    key: z.string().openapi({
      description:
        "2 to 10 letters A-Z or digits, unique across projects; lowercase is stored uppercased. Its issues' keys are this, a dash and their number: TRL-12.",
      example: "TRL",
    }),
    description: text.optional(),
    externalRef: externalRef.optional(),
  })
  .openapi("ProjectCreate");

export const projectUpdateSchema = z
  .strictObject({
    name: name.optional(),
    description: text.optional(),
  })
  .openapi("ProjectUpdate");

export const issueCreateSchema = z
  .strictObject({
    projectId: projectRef,
    title,
    description: text.optional(),
    assigneeId: id.nullable().optional(),
    estimate: estimate.optional(),
    priority: priority.optional(),
    labels: labelNames.optional(),
    links: links.optional(),
    externalRef: externalRef.optional(),
  })
  .openapi("IssueCreate");

export const issueUpdateSchema = z
  .strictObject({
    title: title.optional(),
    description: text.optional(),
    status: issueStatusSchema.optional(),
    assigneeId: id
      .nullable()
      .optional()
      .openapi({ description: "null unassigns." }),
    estimate: estimate
      .nullable()
      .optional()
      .openapi({ description: "Hours; null clears." }),
    priority: priority.optional(),
    labels: labelNames.optional().openapi({
      description: "Replaces the issue's labels; [] removes them all.",
    }),
    links: links.optional().openapi({
      description: "Replaces the issue's links; [] removes them all.",
    }),
  })
  .openapi("IssueUpdate");

export const commentCreateSchema = z
  .strictObject({ body: text.min(1), externalRef: externalRef.optional() })
  .openapi("CommentCreate");

export const statusUpdateCreateSchema = z
  .strictObject({
    body: text.min(1),
    health: healthSchema,
    externalRef: externalRef.optional(),
  })
  .openapi("StatusUpdateCreate");

export const labelCreateSchema = z
  .strictObject({ name: labelName })
  .openapi("LabelCreate");

export const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  // coerce: "" becomes 0, which min(1) rejects
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const issueListQuerySchema = pageQuerySchema.extend({
  projectId: projectRef.optional(),
  status: issueStatusSchema.optional(),
  assigneeId: id.optional(),
});

export const activityListQuerySchema = pageQuerySchema.extend({
  cursor: z.string().optional().openapi({
    description:
      "Pages newest first: pass the previous page's nextCursor. Bound to the projectId and actorId it was issued under.",
  }),
  after: z.string().optional().openapi({
    description:
      "Resumes oldest first after this cursor; empty starts from the first event. The page's nextCursor is never null: pass it as `after` to poll for newer events. Bound to the projectId and actorId it was issued under.",
  }),
  projectId: projectRef.optional(),
  actorId: id.optional(),
});

export type ApiError = z.infer<typeof errorSchema>;
export type ProjectView = z.infer<typeof projectSchema>;
export type IssueView = z.infer<typeof issueSchema>;
export type CommentView = z.infer<typeof commentSchema>;
export type StatusUpdateView = z.infer<typeof statusUpdateSchema>;
export type LabelView = z.infer<typeof labelSchema>;
export type ActivityEventView = z.infer<typeof activityEventSchema>;
export type PageView<T> = { items: T[]; nextCursor: string | null };
