import { z } from "@hono/zod-openapi";

const issueStatusSchema = z
  .enum(["open", "in_progress", "done", "canceled"])
  .openapi("IssueStatus");

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
    name: z.string(),
    description: z.string(),
    createdBy: id,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi("Project");

export const issueSchema = z
  .object({
    id,
    projectId: id,
    title: z.string(),
    description: z.string(),
    status: issueStatusSchema,
    assigneeId: id.nullable(),
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
    createdAt: timestamp,
  })
  .openapi("Comment");

export const activityEventSchema = z
  .object({
    id,
    actorId: id,
    subjectType: z.enum(["project", "issue", "comment"]),
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

// Strict, so a misspelled field is a 422 rather than a write that silently skips it.
export const projectCreateSchema = z
  .strictObject({
    name: z.string().min(1),
    description: z.string().optional(),
  })
  .openapi("ProjectCreate");

export const projectUpdateSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .openapi("ProjectUpdate");

export const issueCreateSchema = z
  .strictObject({
    projectId: id,
    title: z.string().min(1),
    description: z.string().optional(),
    assigneeId: id.nullable().optional(),
  })
  .openapi("IssueCreate");

export const issueUpdateSchema = z
  .strictObject({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    status: issueStatusSchema.optional(),
    assigneeId: id
      .nullable()
      .optional()
      .openapi({ description: "null unassigns." }),
  })
  .openapi("IssueUpdate");

export const commentCreateSchema = z
  .strictObject({ body: z.string().min(1) })
  .openapi("CommentCreate");

export const pageQuerySchema = z.object({
  cursor: z.string().optional(),
  // coerce: "" becomes 0, which min(1) rejects
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const issueListQuerySchema = pageQuerySchema.extend({
  projectId: id.optional(),
  status: issueStatusSchema.optional(),
  assigneeId: id.optional(),
});

export const activityListQuerySchema = pageQuerySchema.extend({
  projectId: id.optional(),
  actorId: id.optional(),
});

export type ApiError = z.infer<typeof errorSchema>;
export type ProjectView = z.infer<typeof projectSchema>;
export type IssueView = z.infer<typeof issueSchema>;
export type CommentView = z.infer<typeof commentSchema>;
export type ActivityEventView = z.infer<typeof activityEventSchema>;
export type PageView<T> = { items: T[]; nextCursor: string | null };
