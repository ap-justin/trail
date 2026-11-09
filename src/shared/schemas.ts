import { z } from "@hono/zod-openapi";
import {
  activitySubjectTypes,
  actorKinds,
  issueStatuses,
  projectHealths,
} from "../server/db/schema.js";
import {
  IMPORT_LINKS_MAX,
  IMPORT_TEXT_MAX,
  sourceStateTypes,
} from "../server/service/import.js";
import {
  ISSUE_LABELS_MAX,
  ISSUE_LINKS_MAX,
} from "../server/service/validate.js";

// Field docs go in .meta(), which both the OpenAPI spec and the MCP tools' JSON
// Schema read; .openapi({ description }) reaches only the spec.
const issueStatusSchema = z.enum(issueStatuses).openapi("IssueStatus");
const healthSchema = z.enum(projectHealths).openapi("ProjectHealth");
const priority = z.int().min(0).max(4).meta({
  description: "0 none, 1 urgent, 2 high, 3 medium, 4 low.",
});
const estimate = z.number().min(0).meta({ description: "Hours." });
const externalRef = z.string().min(1).max(200).meta({
  description:
    "The row's id in the system it came from, like JUS-167; unique within its scope, so a second create with it is a 409.",
  example: "JUS-167",
});
const labelName = z.string().min(1).max(100);
const linkSchema = z
  .object({ url: z.string(), title: z.string() })
  .openapi("Link");

const sourceAuthor = z.string().nullable().meta({
  description:
    "On an imported row, the author's name in the system it came from; createdBy or authorId credits the bot that imported it.",
});

const id = z.string().min(1);
const timestamp = z.iso
  .datetime()
  .meta({ example: "2026-11-08T09:00:00.000Z" });

export const errorSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ example: "not_found" }),
      message: z.string(),
    }),
  })
  .openapi("Error");

export const projectSchema = z
  .object({
    id,
    key: z.string().meta({ example: "TRL" }),
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
    key: z.string().meta({
      description: "The project's key and the issue's number.",
      example: "TRL-12",
    }),
    number: z.int().meta({ example: 12 }),
    sourceKey: z.string().nullable().meta({
      description:
        "On an imported issue, its key in the system it came from, uppercased (like JUS-187). Any argument or path that takes the issue's id or key takes this too.",
      example: "JUS-187",
    }),
    projectId: id,
    title: z.string(),
    description: z.string(),
    status: issueStatusSchema,
    priority,
    estimate: estimate.nullable(),
    labels: z.array(z.string()).meta({ description: "Names, A to Z." }),
    links: z.array(linkSchema),
    assigneeId: id.nullable(),
    externalRef: z.string().nullable(),
    sourceAuthor,
    sourceStatus: z.string().nullable().meta({
      description:
        "On an imported issue, its state's name in the system it came from (like In Review), kept for reference; status is what trail goes by.",
    }),
    createdBy: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp.nullable().meta({
      description:
        "When the issue moved to done or canceled; null while it is open or in progress.",
    }),
  })
  .openapi("Issue");

export const commentSchema = z
  .object({
    id,
    issueId: id,
    authorId: id,
    body: z.string(),
    externalRef: z.string().nullable(),
    sourceAuthor,
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
    sourceAuthor,
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
    action: z.string().meta({ example: "issue.updated" }),
    payload: z.record(z.string(), z.unknown()),
    createdAt: timestamp,
  })
  .openapi("ActivityEvent");

const actorName = z.string().meta({ example: "migrator" });
const actorLabel = z.string().nullable().meta({
  description:
    "A bot's agent id in the system that runs it, unique among bots; null when it has none, and on a human.",
  example: "agent-7",
});

export const actorSchema = z
  .object({
    id,
    kind: z.enum(actorKinds),
    name: actorName,
    label: actorLabel,
  })
  .openapi("Actor");

export const botSchema = z
  .object({ id, name: actorName, label: actorLabel })
  .openapi("Bot");

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().meta({
      description: "Pass as `cursor` for the next page; null on the last.",
    }),
  });
}

export const activityPageSchema = pageSchema(activityEventSchema).extend({
  nextCursor: z.string().nullable().meta({
    description:
      "On a page read with `after`: pass it back as `after` to get only newer events; never null, and an empty page means nothing new yet. Otherwise: pass it back as `cursor` for the next older page; null on the last. Sent on the other parameter, it is a 422.",
  }),
});

const name = z.string().min(1).max(200);
const title = z.string().min(1).max(300);
// counted in UTF-16 units, so at most 192 KiB of UTF-8: room under MAX_BODY_BYTES (server/api/routes.ts)
const text = z.string().max(64 * 1024);

// Strict, so a misspelled field is a 422 rather than a write that silently skips it.
const projectRef = id.meta({
  description: "The project's id or its key, like TRL.",
});
const labelNames = z.array(labelName).max(ISSUE_LABELS_MAX).meta({
  description:
    "Label names. A name matches the project's label ignoring the case of A-Z; a new name creates the label.",
});
const links = z
  .array(
    z.strictObject({
      // not z.httpUrl(): it also demands a dotted domain, refusing http://localhost
      url: z
        .url({ protocol: /^https?$/, error: "must be an http or https url" })
        .max(2048),
      title: z
        .string()
        .max(300)
        .optional()
        .meta({ description: "Defaults to the url." }),
    }),
  )
  .max(ISSUE_LINKS_MAX);

// the service's rule (service/validate.ts) before it uppercases, so the spec and MCP schema carry it
const projectKey = z
  .string()
  .regex(
    /^[A-Za-z0-9]{2,10}$/,
    "must be 2 to 10 letters A-Z or digits, like TRL",
  );

export const projectCreateSchema = z
  .strictObject({
    name,
    key: projectKey.meta({
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
      .meta({ description: "null unassigns." }),
    estimate: estimate
      .nullable()
      .optional()
      .meta({ description: "Hours; null clears." }),
    priority: priority.optional(),
    labels: labelNames.optional().meta({
      description: "Replaces the issue's labels; [] removes them all.",
    }),
    links: links.optional().meta({
      description: "Replaces the issue's links; [] removes them all.",
    }),
    addLabels: labelNames.optional().meta({
      description:
        "Labels to add, keeping the issue's others, even those another bot added a moment ago. A name matches the project's label ignoring the case of A-Z; a new name creates the label. Not with labels.",
    }),
    removeLabels: z.array(labelName).max(50).optional().meta({
      description:
        "Labels to remove, by name ignoring the case of A-Z; a name the issue lacks is ignored. Not with labels.",
    }),
    addLinks: links.optional().meta({
      description:
        "Links to add, keeping the issue's others. A url already on the issue takes the title sent here, or keeps its own when none is sent. Not with links.",
    }),
    removeLinks: z.array(z.string().min(1).max(2048)).max(50).optional().meta({
      description:
        "Urls of links to remove; a url the issue lacks is ignored. Not with links.",
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

// a source system's timestamps carry an offset or Z
const sourceTimestamp = z.iso
  .datetime({ offset: true })
  .meta({ example: "2026-01-02T03:04:05.000Z" });
const sourceRef = z.string().min(1).max(200).meta({
  description:
    "The row's id in the system it came from: Linear's id, a UUID, not an identifier like JUS-187, which Linear changes when an issue moves team. A re-run matches rows by it: the project across trail, an issue within its project, a comment within its issue, a status update within its project.",
  example: "2b5f6e1c-7d0a-4c3e-9f1b-8a6d4e2c1f07",
});
const sourceAuthorInput = z
  .string()
  .min(1)
  .max(200)
  .nullable()
  .optional()
  .meta({
    description: "The author's name in the source system.",
  });

// An import row's values are checked by the service (service/import.ts), which reports every failing
// row with its sourceKey or externalRef in one 422; a schema failure is reported by path
// (issues.3.title) and names no row. These schemas fix the shape, and `meta` carries the limits for the
// spec and the MCP tool. Fields still checked here are listed in the import route and tool descriptions.
const importLinks = z
  .array(
    z.strictObject({
      url: z.string().meta({
        description: "An http or https url of at most 2048 characters.",
      }),
      title: z
        .string()
        .optional()
        .meta({ description: "At most 300 characters; defaults to the url." }),
    }),
  )
  .meta({ maxItems: IMPORT_LINKS_MAX });
const importText = (what: string) =>
  z.string().meta({
    description: `${what}, at most ${IMPORT_TEXT_MAX} characters.`,
    maxLength: IMPORT_TEXT_MAX,
  });

const importCommentSchema = z
  .strictObject({
    externalRef: sourceRef,
    body: importText("The comment"),
    createdAt: sourceTimestamp,
    sourceAuthor: sourceAuthorInput,
  })
  .openapi("ImportComment");

const importIssueSchema = z
  .strictObject({
    externalRef: sourceRef,
    sourceKey: z.string().optional().meta({
      pattern: "^[A-Za-z0-9]{2,10}-[1-9]\\d*$",
      description:
        "The issue's key in the system it came from (Linear's identifier, like JUS-187; a letter-or-digit prefix, a dash and a number). It is stored uppercased, and the issue is found by it wherever an id or key is taken, after them: an id or key that looks the same wins; a re-run sets it to the value sent. When its prefix is the project's key, a new issue keeps that number, so JUS-187 in Linear is JUS-187 in trail; if another issue already holds the number, the new one gets the project's next number and is listed in the result's renumbered, and is reached by the key listed there, since its sourceKey finds the issue holding that key. An imported issue's number never changes on a re-run. Unique across trail. Without it, an externalRef shaped like JUS-187 keeps its number instead.",
      example: "JUS-187",
    }),
    title: z.string().meta({ description: "1 to 300 characters." }),
    description: importText("The issue's description").optional(),
    status: z.string().optional().meta({
      description:
        "The source state's name (Linear's state.name), kept as the issue's sourceStatus (at most 200 characters). Without statusType it decides the status, in any case: Backlog, Todo or Triage → open, In Progress → in_progress, Done → done, Canceled or Duplicate → canceled, and a trail status (open, in_progress, done, canceled) as is; any other name needs statusType. Send status, statusType or both; a re-run without status clears sourceStatus.",
      example: "In Review",
    }),
    statusType: z
      .string()
      .optional()
      .meta({
        enum: [...sourceStateTypes],
        description:
          "The source state's type (Linear's state.type), in any case; when sent it decides the status: backlog, unstarted or triage → open, started → in_progress, completed → done, canceled or duplicate → canceled. Send it for a custom state, like In Review of type started.",
        example: "started",
      }),
    priority: z.number().optional().meta({
      description: "0 none, 1 urgent, 2 high, 3 medium, 4 low.",
    }),
    estimate: z
      .number()
      .nullable()
      .optional()
      .meta({ description: "Hours, 0 or more." }),
    labels: z.array(z.string()).optional().meta({
      description:
        "Replaces the issue's labels; a new name creates the label. At most 50, each at most 100 characters.",
      maxItems: 50,
    }),
    links: importLinks.optional().meta({
      description: `Replaces the issue's links. At most ${IMPORT_LINKS_MAX}.`,
    }),
    createdAt: sourceTimestamp,
    completedAt: sourceTimestamp.nullable().optional().meta({
      description:
        "When it was done or canceled (Linear's completedAt or canceledAt); only on a done or canceled issue. A closed issue sent without one is stamped with the time of its first import.",
    }),
    sourceAuthor: sourceAuthorInput,
    comments: z.array(importCommentSchema).optional(),
  })
  .openapi("ImportIssue");

const importStatusUpdateSchema = z
  .strictObject({
    externalRef: sourceRef,
    body: z.string().meta({
      description: "At most 65536 characters.",
      maxLength: 64 * 1024,
    }),
    health: healthSchema,
    createdAt: sourceTimestamp,
    sourceAuthor: sourceAuthorInput,
  })
  .openapi("ImportStatusUpdate");

export const importSchema = z
  .strictObject({
    externalRef: sourceRef,
    key: projectKey.meta({
      description:
        "The project's key, like TRL: 2 to 10 letters A-Z or digits. Fixed once imported; a re-run sends the same key.",
      example: "TRL",
    }),
    name,
    description: text.optional(),
    createdAt: sourceTimestamp.optional(),
    labels: z.array(labelName).max(1000).optional().meta({
      description:
        "Label names to create in the project beside those its issues name.",
    }),
    issues: z.array(importIssueSchema).optional(),
    statusUpdates: z.array(importStatusUpdateSchema).optional(),
  })
  .openapi("Import");

const importCountsSchema = z
  .object({
    projects: z.int(),
    issues: z.int(),
    comments: z.int(),
    labels: z.int(),
    links: z.int(),
    statusUpdates: z.int(),
  })
  .openapi("ImportCounts");

export const importResultSchema = z
  .object({
    project: projectSchema,
    renumbered: z
      .array(
        z.object({
          externalRef: z.string(),
          sourceKey: z.string().nullable(),
          key: z.string().meta({ example: "DEMO-12" }),
        }),
      )
      .meta({
        description:
          "Issues created without the number their sourceKey asked for, because another issue in the project held it. Each is reached by its key here: its sourceKey is the key of the issue that held the number, so it finds that issue.",
      }),
    created: importCountsSchema,
    updated: importCountsSchema,
    unchanged: importCountsSchema,
  })
  .openapi("ImportResult");

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
  cursor: z.string().optional().meta({
    description:
      "Pages newest first: pass the nextCursor of the previous page read without `after`. Bound to the projectId and actorId it was issued under.",
  }),
  after: z.string().optional().meta({
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
export type ActorView = z.infer<typeof actorSchema>;
export type BotView = z.infer<typeof botSchema>;
export type ActivityEventView = z.infer<typeof activityEventSchema>;
export type ImportResultView = z.infer<typeof importResultSchema>;
export type PageView<T> = { items: T[]; nextCursor: string | null };
