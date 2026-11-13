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
  webhookCreateSchema,
  webhookSecretUpdateSchema,
  webhookUpdateSchema,
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
  toWebhook,
  toWhoami,
} from "../api/serialize.js";
import { actorPhotoContentTypes } from "../db/schema.js";
import {
  InvalidImageError,
  PayloadTooLargeError,
  ServiceError,
} from "../service/errors.js";
import type { Service } from "../service/index.js";
import type { KeyActor } from "../service/keys.js";
import {
  PHOTO_ACCEPTS,
  PHOTO_MAX_BYTES,
  photoTooLarge,
} from "../service/photos.js";
import { PING_LIMIT, PING_WINDOW_MS } from "../service/webhooks.js";
import { WEBHOOK_DELIVERY, WEBHOOK_SETUP } from "../webhooks/docs.js";

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

const photoEncoding =
  "base64-encoded (standard or URL-safe alphabet, padded or not; line breaks are fine), bare or prefixed like data:image/png;base64,";

/** The media types a data: URL prefix may declare; image/jpg is the common misspelling of image/jpeg. */
const dataUrlImageTypes: readonly string[] = [
  ...actorPhotoContentTypes,
  "image/jpg",
];

/** The longest padded base64 a photo of `PHOTO_MAX_BYTES` encodes to. */
const MAX_PHOTO_BASE64_LENGTH = Math.ceil(PHOTO_MAX_BYTES / 3) * 4;

/** The longest raw `data` read at all: room for CRLF wrapping, a data: URL prefix and stray whitespace around the largest photo. */
const MAX_PHOTO_DATA_LENGTH = MAX_PHOTO_BASE64_LENGTH * 2;

/** The bytes of `set_my_photo`'s data: strict base64 once whitespace is dropped and URL-safe or unpadded input is made standard, after an optional image data: URL prefix. */
function photoBytes(data: string): Uint8Array {
  // /mcp takes bodies far larger than any photo; refuse those before trimming or stripping copies them
  if (data.length > MAX_PHOTO_DATA_LENGTH) {
    throw new PayloadTooLargeError(photoTooLarge(null));
  }
  let encoded = data.trimStart();
  const dataUrl = /^data:([^;,]*)(;[^,]*)?,/.exec(encoded);
  if (dataUrl) {
    const [prefix, type = "", params = ""] = dataUrl;
    // RFC 2397 puts any parameters, like name= or charset=, before ;base64
    if (
      !dataUrlImageTypes.includes(type.toLowerCase()) ||
      !params.toLowerCase().endsWith(";base64")
    ) {
      throw new InvalidImageError(
        `data declares ${type || "no type"}${params}: send ${PHOTO_ACCEPTS}, ${photoEncoding}`,
      );
    }
    encoded = encoded.slice(prefix.length);
  }
  // `base64 file` wraps its output at 76 columns
  encoded = encoded.replace(/[\t\n\f\r ]/g, "");
  encoded = encoded.replaceAll("-", "+").replaceAll("_", "/");
  // a length of 1 past a group of 4 can't be padded; the round trip below refuses it
  if (encoded.length % 4 > 1) encoded += "=".repeat(4 - (encoded.length % 4));
  // refused before decoding, so an oversized string never allocates its bytes
  if (encoded.length > MAX_PHOTO_BASE64_LENGTH) {
    throw new PayloadTooLargeError(photoTooLarge(null));
  }
  const bytes = Buffer.from(encoded, "base64");
  // Buffer skips characters it can't decode; a round trip that differs means it did
  if (bytes.toString("base64") !== encoded) {
    throw new InvalidImageError(
      `data is not valid base64: send ${PHOTO_ACCEPTS}, ${photoEncoding}`,
    );
  }
  return bytes;
}

/** The service call's result as JSON, or a tool error a bot can act on. */
function run(tool: string, call: () => unknown): CallToolResult {
  try {
    return json(call());
  } catch (error) {
    return failed(tool, error);
  }
}

/** `run` for a call that awaits. */
async function runAsync(
  tool: string,
  call: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return json(await call());
  } catch (error) {
    return failed(tool, error);
  }
}

function failed(tool: string, error: unknown): CallToolResult {
  // each service message names what was refused and what to send instead
  if (error instanceof ServiceError) {
    return failure(`${error.code}: ${error.message}`);
  }
  console.error(`unhandled error in MCP tool ${tool}`, error);
  return failure(
    `internal: trail failed on its side. Retry ${tool} once; if it fails again, stop and report the tool name and its arguments.`,
  );
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
        "Get the bot this key acts as: its id (the createdBy, authorId and actorId your writes carry), name, label and photoUrl (null until set_my_photo sets one), and the key's scope: the keys of the only projects it reaches and the actions it may take (read, issues, comments, status_updates, admin), each null when unrestricted.",
      inputSchema: z.strictObject({}),
      annotations: read,
    },
    () => run("whoami", () => toWhoami(service.whoami(actor), actor.scope)),
  );

  server.registerTool(
    "list_bots",
    {
      description:
        "List every bot, oldest first, with its id, name, label and photoUrl, a page at a time: pass nextCursor back as cursor until it is null. A createdBy, authorId or actorId that matches a bot's id was written by that bot; an id that matches no bot is a human's (humans file issues and comment).",
      inputSchema: z.strictObject(page),
      annotations: read,
    },
    (query) =>
      run("list_bots", () => toPage(service.listBots(actor, query), toBot)),
  );

  server.registerTool(
    "set_my_photo",
    {
      description: `Set your own photo, which people see beside your name in trail. Send ${PHOTO_ACCEPTS}, ${photoEncoding} Its type is read from the bytes. The whole image goes in this one argument, so send a small avatar: about 128x128px, under about 16 KB. For a larger file, send its raw bytes to PUT /api/v1/me/photo with this same key instead. A new photo replaces the old one and gets a new photoUrl. Every key may call this, whatever its scope.`,
      inputSchema: z.strictObject({
        data: z.string().describe(`The image, ${photoEncoding}`),
      }),
      // the photo it replaces is gone for good
      annotations: { ...update, destructiveHint: true },
    },
    ({ data }) =>
      run("set_my_photo", () => service.setMyPhoto(actor, photoBytes(data))),
  );

  server.registerTool(
    "clear_my_photo",
    {
      description:
        "Remove your own photo; succeeds when you have none too. Every key may call this, whatever its scope.",
      inputSchema: z.strictObject({}),
      annotations: { ...update, destructiveHint: true },
    },
    () => run("clear_my_photo", () => service.clearMyPhoto(actor)),
  );

  const webhookId = z
    .string()
    .min(1)
    .describe("The webhook's id, from create_webhook or list_webhooks.");
  const ownWebhooks =
    "Acts on your own webhooks only; another bot's, or one following a project outside this key's scope, is not found.";

  server.registerTool(
    "create_webhook",
    {
      description: `Get a signed webhook call for every event in projects you follow, so you hear of an issue another bot files without polling list_activity. Needs the read action. ${WEBHOOK_SETUP} ${WEBHOOK_DELIVERY} Returns the webhook (never its secret); a project this key can't read is not found.`,
      inputSchema: webhookCreateSchema,
      annotations: create,
    },
    (input) =>
      runAsync("create_webhook", async () =>
        toWebhook(await service.createWebhook(actor, input)),
      ),
  );

  server.registerTool(
    "list_webhooks",
    {
      description: `List your webhooks, oldest first, each with the projects it follows, paused, lastSuccessAt, lastError and lastErrorAt: read it to see whether deliveries are healthy. The secret is never listed. Needs the read action. ${ownWebhooks}`,
      inputSchema: z.strictObject({}),
      annotations: read,
    },
    () =>
      run("list_webhooks", () =>
        toPage(service.listWebhooks(actor), toWebhook),
      ),
  );

  server.registerTool(
    "update_webhook",
    {
      description: `Change a webhook's url or the projects it follows (projects replaces the whole list), and resume it if it was paused: an update with no fields still resumes. Fields left out stay as they are. To change the secret use rotate_webhook_secret. Needs the read action. ${ownWebhooks}`,
      inputSchema: webhookUpdateSchema.extend({ webhookId }),
      annotations: update,
    },
    ({ webhookId, ...patch }) =>
      runAsync("update_webhook", async () =>
        toWebhook(await service.updateWebhook(actor, webhookId, patch)),
      ),
  );

  server.registerTool(
    "rotate_webhook_secret",
    {
      description: `Replace a webhook's signing secret, and resume it if it was paused. The old secret stops signing at once, so give your routine the new one first. Read the secret from a key in a script, never from chat; it is never returned. Needs the read action. ${ownWebhooks}`,
      inputSchema: webhookSecretUpdateSchema.extend({ webhookId }),
      annotations: update,
    },
    ({ webhookId, secret }) =>
      run("rotate_webhook_secret", () =>
        toWebhook(service.rotateWebhookSecret(actor, webhookId, secret)),
      ),
  );

  server.registerTool(
    "delete_webhook",
    {
      description: `Delete a webhook and the deliveries still queued for it. Needs the read action. ${ownWebhooks}`,
      inputSchema: z.strictObject({ webhookId }),
      annotations: { ...update, destructiveHint: true },
    },
    ({ webhookId }) =>
      run("delete_webhook", () => service.deleteWebhook(actor, webhookId)),
  );

  server.registerTool(
    "test_webhook",
    {
      description: `Send one signed trail.ping to a webhook now and see what its receiver answered: delivered, the HTTP status, and an error when it failed. Run it after create_webhook to check your OpenBot routine accepts the signature, and after a pause before you update the webhook. A webhook takes ${PING_LIMIT} tests per ${PING_WINDOW_MS / 1000} seconds; past that a test is refused as rate_limited with the seconds to wait. Needs the read action. ${ownWebhooks}`,
      inputSchema: z.strictObject({ webhookId }),
      annotations: { ...create, openWorldHint: true },
    },
    ({ webhookId }) =>
      runAsync("test_webhook", () => service.testWebhook(actor, webhookId)),
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
