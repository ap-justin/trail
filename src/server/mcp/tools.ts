import { z } from "@hono/zod-openapi";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import {
  activityListQuerySchema,
  commentCreateSchema,
  importSchema,
  issueCreateSchema,
  issueListQuerySchema,
  issueUpdateSchema,
  labelCreateSchema,
  projectCreateSchema,
  projectUpdateSchema,
  statusUpdateCreateSchema,
} from "../../shared/schemas.js";
import {
  toActivityEvent,
  toBot,
  toComment,
  toImportResult,
  toIssue,
  toLabel,
  toPage,
  toProject,
  toStatusUpdate,
  toWhoami,
} from "../api/serialize.js";
import { ServiceError } from "../service/errors.js";
import type { Service } from "../service/index.js";
import type { KeyActor } from "../service/keys.js";

const projectId = z
  .string()
  .min(1)
  .describe("The project's id or its key, like TRL.");
const issueId = z
  .string()
  .min(1)
  .describe(
    "The issue's id, its key (like TRL-12) or its source key (like JUS-187, kept from an import). Looked up in that order, so a key beats a source key that looks the same.",
  );
const idempotencyKey = {
  idempotency_key: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "Makes the create safe to retry: a repeat with the same key and arguments returns the first result and saves nothing.",
    ),
};
const page = {
  cursor: z
    .string()
    .optional()
    .describe("The previous page's nextCursor, to read the next page."),
  limit: z
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Default 50, at most 200."),
};

const read: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const create: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const update: ToolAnnotations = { ...create, idempotentHint: true };

const json = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const failure = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** The service call's result as JSON, or a tool error a bot can act on. */
function run(tool: string, call: () => unknown): CallToolResult {
  try {
    return json(call());
  } catch (error) {
    // each service message names what was refused and what to send instead
    if (error instanceof ServiceError) {
      return failure(`${error.code}: ${error.message}`);
    }
    console.error(`unhandled error in MCP tool ${tool}`, error);
    return failure(
      `internal: trail failed on its side. Retry ${tool} once; if it fails again, stop and report the tool name and its arguments.`,
    );
  }
}

/** Registers every trail tool on `server`, each acting as `actor` within its key's scope. */
export function registerTools(
  server: McpServer,
  service: Service,
  actor: KeyActor,
): void {
  server.registerTool(
    "create_project",
    {
      description:
        "Create a project. Its key (like TRL) prefixes its issues' keys (TRL-1, TRL-2, ...) and must be unused. To bring a project over from Linear, use import_project instead.",
      inputSchema: projectCreateSchema.extend(idempotencyKey),
      annotations: create,
    },
    ({ idempotency_key, ...input }) =>
      run("create_project", () =>
        toProject(
          service.createProject(actor, input, {
            idempotencyKey: idempotency_key,
          }),
        ),
      ),
  );

  server.registerTool(
    "get_project",
    {
      description: "Get a project by its id or key.",
      inputSchema: z.strictObject({ projectId }),
      annotations: read,
    },
    ({ projectId }) =>
      run("get_project", () => toProject(service.getProject(actor, projectId))),
  );

  server.registerTool(
    "list_projects",
    {
      description:
        "List projects, newest first, a page at a time: pass nextCursor back as cursor until it is null.",
      inputSchema: z.strictObject(page),
      annotations: read,
    },
    (query) =>
      run("list_projects", () =>
        toPage(service.listProjects(actor, query), toProject),
      ),
  );

  server.registerTool(
    "update_project",
    {
      description:
        "Change a project's name or description. Fields left out stay as they are.",
      inputSchema: projectUpdateSchema.extend({ projectId }),
      annotations: update,
    },
    ({ projectId, ...patch }) =>
      run("update_project", () =>
        toProject(service.updateProject(actor, projectId, patch)),
      ),
  );

  server.registerTool(
    "create_issue",
    {
      description:
        "Open an issue in a project. It gets the project's next number, so its key reads like TRL-12. Label names are matched ignoring the case of A-Z (so É and é differ), and a new name creates the label. Links (a PR, say) are a url and an optional title.",
      inputSchema: issueCreateSchema.extend(idempotencyKey),
      annotations: create,
    },
    ({ idempotency_key, ...input }) =>
      run("create_issue", () =>
        toIssue(
          service.createIssue(actor, input, {
            idempotencyKey: idempotency_key,
          }),
        ),
      ),
  );

  server.registerTool(
    "get_issue",
    {
      description:
        "Get an issue by its id, key (like TRL-12) or source key (like JUS-187). The result carries its sourceKey.",
      inputSchema: z.strictObject({ issueId }),
      annotations: read,
    },
    ({ issueId }) =>
      run("get_issue", () => toIssue(service.getIssue(actor, issueId))),
  );

  server.registerTool(
    "list_issues",
    {
      description:
        "List issues, newest first, optionally of one project, status or assignee, a page at a time: pass nextCursor back as cursor until it is null.",
      inputSchema: z.strictObject({
        projectId: projectId.optional(),
        status: issueListQuerySchema.shape.status,
        assigneeId: issueListQuerySchema.shape.assigneeId,
        ...page,
      }),
      annotations: read,
    },
    (query) =>
      run("list_issues", () =>
        toPage(service.listIssues(actor, query), toIssue),
      ),
  );

  server.registerTool(
    "update_issue",
    {
      description:
        "Change an issue: title, description, status (open, in_progress, done, canceled), assignee, estimate, priority, labels or links. Fields left out stay as they are. To change the issue's labels or links, either send labels or links to replace the whole set, or send addLabels, removeLabels, addLinks and removeLinks to change part of it without touching the rest, safe beside another bot's edit. Sending labels with addLabels or removeLabels, or links with addLinks or removeLinks, is refused. Moving to done or canceled stamps completedAt; reopening clears it.",
      inputSchema: issueUpdateSchema.extend({ issueId }),
      annotations: update,
    },
    ({ issueId, ...patch }) =>
      run("update_issue", () =>
        toIssue(service.updateIssue(actor, issueId, patch)),
      ),
  );

  server.registerTool(
    "add_comment",
    {
      description:
        "Add a comment to an issue, named by its id, key (like TRL-12) or source key (like JUS-187).",
      inputSchema: commentCreateSchema.extend({ issueId, ...idempotencyKey }),
      annotations: create,
    },
    ({ issueId, idempotency_key, ...input }) =>
      run("add_comment", () =>
        toComment(
          service.addComment(
            actor,
            { ...input, issueId },
            { idempotencyKey: idempotency_key },
          ),
        ),
      ),
  );

  server.registerTool(
    "list_comments",
    {
      description:
        "List an issue's comments, oldest first, a page at a time: pass nextCursor back as cursor until it is null.",
      inputSchema: z.strictObject({ issueId, ...page }),
      annotations: read,
    },
    ({ issueId, ...query }) =>
      run("list_comments", () =>
        toPage(service.listComments(actor, issueId, query), toComment),
      ),
  );

  server.registerTool(
    "create_label",
    {
      description:
        "Create a label in a project. Naming a new label on create_issue or update_issue creates it too.",
      inputSchema: labelCreateSchema.extend({ projectId, ...idempotencyKey }),
      annotations: create,
    },
    ({ projectId, idempotency_key, ...input }) =>
      run("create_label", () =>
        toLabel(
          service.createLabel(
            actor,
            { ...input, projectId },
            { idempotencyKey: idempotency_key },
          ),
        ),
      ),
  );

  server.registerTool(
    "list_labels",
    {
      description:
        "List a project's labels, oldest first, a page at a time: pass nextCursor back as cursor until it is null.",
      inputSchema: z.strictObject({ projectId, ...page }),
      annotations: read,
    },
    ({ projectId, ...query }) =>
      run("list_labels", () =>
        toPage(service.listLabels(actor, projectId, query), toLabel),
      ),
  );

  server.registerTool(
    "post_status_update",
    {
      description:
        "Post a dated status update on a project, with its health: on_track, at_risk or off_track.",
      inputSchema: statusUpdateCreateSchema.extend({
        projectId,
        ...idempotencyKey,
      }),
      annotations: create,
    },
    ({ projectId, idempotency_key, ...input }) =>
      run("post_status_update", () =>
        toStatusUpdate(
          service.createStatusUpdate(
            actor,
            { ...input, projectId },
            { idempotencyKey: idempotency_key },
          ),
        ),
      ),
  );

  server.registerTool(
    "list_status_updates",
    {
      description:
        "List a project's status updates, newest first, a page at a time: pass nextCursor back as cursor until it is null.",
      inputSchema: z.strictObject({ projectId, ...page }),
      annotations: read,
    },
    ({ projectId, ...query }) =>
      run("list_status_updates", () =>
        toPage(
          service.listStatusUpdates(actor, projectId, query),
          toStatusUpdate,
        ),
      ),
  );

  server.registerTool(
    "list_activity",
    {
      description:
        'Read the activity feed, optionally of one project or actor. To follow it, pass after: "" for the first events, oldest first, then each page\'s nextCursor as after to get only newer events (never null; an empty page means nothing new yet). Without after, it pages newest first through cursor. A cursor only works with the projectId and actorId it was issued under.',
      inputSchema: z.strictObject({
        after: activityListQuerySchema.shape.after,
        cursor: activityListQuerySchema.shape.cursor,
        limit: page.limit,
        projectId: projectId.optional(),
        actorId: activityListQuerySchema.shape.actorId,
      }),
      annotations: read,
    },
    (query) =>
      run("list_activity", () =>
        toPage(service.listActivity(actor, query), toActivityEvent),
      ),
  );

  server.registerTool(
    "whoami",
    {
      description:
        "Get the bot this key acts as: its id (the createdBy, authorId and actorId your writes carry), name and label, and the key's scope: the keys of the only projects it reaches and the actions it may take (read, issues, comments, status_updates, admin), each null when unrestricted.",
      inputSchema: z.strictObject({}),
      annotations: read,
    },
    () => run("whoami", () => toWhoami(service.whoami(actor), actor.scope)),
  );

  server.registerTool(
    "list_bots",
    {
      description:
        "List every bot, oldest first, with its id, name and label, a page at a time: pass nextCursor back as cursor until it is null. A createdBy, authorId or actorId that matches a bot's id was written by that bot; an id that matches no bot is a human's (humans file issues and comment).",
      inputSchema: z.strictObject(page),
      annotations: read,
    },
    (query) =>
      run("list_bots", () => toPage(service.listBots(actor, query), toBot)),
  );

  server.registerTool(
    "import_project",
    {
      description:
        "Bring a whole project over from Linear (or another tracker) in one call: the project with its issues, their comments, labels and links, and its status updates, each keyed by externalRef (Linear's id, a UUID). Send each issue's sourceKey (Linear's identifier, like JUS-187): trail stores it, so JUS-187 finds the issue in get_issue, update_issue and add_comment from then on, and a new issue keeps that number when its prefix is the project's key. If that number is taken by another issue, the new one gets the project's next number and is listed in the result's renumbered with its new key; nothing fails. Use that new key for a renumbered issue: its sourceKey is the other issue's key, so it finds the other issue. Descriptions and comment bodies may be up to 1048576 characters and an issue may have up to 200 links. The payload is checked in two passes, and nothing is imported unless both pass. First its shape: a missing or unknown field, a value of the wrong type, the project's key, name, description or labels, and any row's externalRef, createdAt, completedAt, sourceAuthor or health; the error names every such failure by its path, like issues.3.createdAt. Then every other value; the error lists every failing row with its sourceKey or externalRef. Fix everything an error lists before sending the import again. Send each issue's statusType (Linear's state.type) and status (its state name, kept as sourceStatus): statusType maps backlog/unstarted/triage → open, started → in_progress, completed → done, canceled/duplicate → canceled; without it, status names map Backlog/Todo/Triage → open, In Progress → in_progress, Done → done, Canceled/Duplicate → canceled. Rows are matched by externalRef, so a re-run never duplicates; it sets each matched row's fields, labels and links to the payload's values, replacing changes made in trail since the last import, and never deletes rows. An imported issue's number never changes; a label that differs from the project's only by case is renamed to the payload's spelling. Returns per kind how many rows were created, updated and unchanged, and renumbered.",
      inputSchema: importSchema,
      // a re-run overwrites bots' edits to matched rows
      annotations: { ...update, destructiveHint: true },
    },
    (payload) =>
      run("import_project", () =>
        toImportResult(service.importProject(actor, payload)),
      ),
  );
}
