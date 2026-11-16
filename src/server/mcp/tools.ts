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
  issueFileSchema,
  issueListQuerySchema,
  issueUpdateSchema,
  itemListQuerySchema,
  itemUpdateSchema,
  labelCreateSchema,
  myTitleUpdateSchema,
  productCreateSchema,
  productUpdateSchema,
  projectCreateSchema,
  projectItemsSchema,
  projectUpdateSchema,
  statusUpdateCreateSchema,
  todoCreateSchema,
  webhookCreateSchema,
  webhookSecretUpdateSchema,
  webhookUpdateSchema,
} from "../../shared/schemas.js";
import { deprecations } from "../api/deprecations.js";
import { TODO_OR_ISSUE } from "../api/items.js";
import {
  deprecated,
  toActivityEvent,
  toBot,
  toComment,
  toImportResult,
  toIssue,
  toLabel,
  toPage,
  toProduct,
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
  ValidationError,
} from "../service/errors.js";
import type { ProjectOrProduct, Service } from "../service/index.js";
import type { KeyActor } from "../service/keys.js";
import {
  PHOTO_ACCEPTS,
  PHOTO_MAX_BYTES,
  photoTooLarge,
} from "../service/photos.js";
import { BOT_TITLE_MAX } from "../service/validate.js";
import { PING_LIMIT, PING_WINDOW_MS } from "../service/webhooks.js";
import { WEBHOOK_DELIVERY, WEBHOOK_SETUP } from "../webhooks/docs.js";

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

/**
 * The one of a canonical argument and its deprecated alias that was sent, and
 * the note to carry when the alias was; sending both is refused.
 */
function eitherOf(
  value: string | undefined,
  alias: string | undefined,
  names: [string, string],
): { value: string | undefined; note: string | undefined } {
  if (value !== undefined && alias !== undefined) {
    throw new ValidationError(
      `send ${names[0]} alone: ${names[1]} is its deprecated alias, and both together is ambiguous`,
    );
  }
  return {
    value: value ?? alias,
    note:
      alias === undefined
        ? undefined
        : `${names[1]} is deprecated: send ${names[0]} instead`,
  };
}

/** The item an `item` argument or its `issueId` alias names; one is required. */
function itemArg(item: string | undefined, issueId: string | undefined) {
  const ref = eitherOf(item, issueId, ["item", "issueId"]);
  if (ref.value === undefined) {
    throw new ValidationError(
      "item is required: send the item's key, like TRL-12; list_items finds them",
    );
  }
  return ref as { value: string; note: string | undefined };
}

/** `view` with a `deprecated` note when there is one. */
const noted = <T extends object>(view: T, note: string | undefined) =>
  note === undefined ? view : deprecated(view, note);

/** "DEPRECATED alias of <tool> (removed after the next release)": the start of every alias's description. */
const aliasOf = (tool: string) =>
  `DEPRECATED alias of ${tool} (removed after the next release): call ${tool} instead.`;

/** Registers every trail tool on `server`, each acting as `actor` within its key's scope. */
export function registerTools(
  server: McpServer,
  service: Service,
  actor: KeyActor,
): void {
  const item = z
    .string()
    .min(1)
    .describe(
      "The item's key, like TRL-12 (or its id, or the source key it kept from an import, like JUS-187).",
    );
  const issueIdAlias = z
    .string()
    .min(1)
    .optional()
    .describe("Deprecated alias of item.");
  const product = z
    .string()
    .min(1)
    .describe(
      "The product's key, like TRL (any case); list_products lists those this key reaches.",
    );
  const projectIdAlias = z
    .string()
    .min(1)
    .optional()
    .describe("Deprecated alias of product: a product's key.");
  const projectSlug = z
    .string()
    .min(1)
    .describe("The project's slug, like launch-q4; list_projects lists them.");

  server.registerTool(
    "add_todo",
    {
      description: `Add a todo: planned work in a product you own (or any product this key reaches, when you name it). ${TODO_OR_ISSUE} Use file_issue instead to report a bug or ask for work in someone else's product. Without product it goes to the one product you own; with none or several, the error lists the products to pick from. Label names match the product's labels ignoring the case of A-Z, and a new name creates the label. Returns the item with its key, like TRL-12.`,
      inputSchema: todoCreateSchema.extend(idempotencyKey),
      annotations: create,
    },
    ({ idempotency_key, ...input }) =>
      run("add_todo", () =>
        toIssue(
          service.addTodo(actor, input, { idempotencyKey: idempotency_key }),
        ),
      ),
  );

  server.registerTool(
    "file_issue",
    {
      description: `File an issue: a bug report or request to a product's bot, on any product this key reaches. ${TODO_OR_ISSUE} Use add_todo instead for planned work in your own product. Leave assignee out: the product's bot assigns it when it accepts the issue. Returns the item with its key, like TRL-12, in status triage.`,
      inputSchema: issueFileSchema.extend(idempotencyKey),
      annotations: create,
    },
    ({ idempotency_key, ...input }) =>
      run("file_issue", () =>
        toIssue(
          service.fileIssue(actor, input, { idempotencyKey: idempotency_key }),
        ),
      ),
  );

  server.registerTool(
    "get_item",
    {
      description:
        "Get an item (a todo or an issue) by its key, like TRL-12: type, product, status, assignee, labels, links and the projects it is in.",
      inputSchema: z.strictObject({ item }),
      annotations: read,
    },
    ({ item }) => run("get_item", () => toIssue(service.getItem(actor, item))),
  );

  server.registerTool(
    "update_item",
    {
      description: `Change an item: type, status, assignee, priority, labels, title, description, estimate or links. ${TODO_OR_ISSUE} To accept an issue from your product's triage send status open with assignee, the bot that will work on it (often you), since status open alone leaves it unassigned; or send type todo, which opens it and assigns the product's owner when it has no assignee. To drop it send status canceled. A todo never goes back to triage and never loses its assignee. Fields left out stay as they are. labels or links replace the whole set; addLabels, removeLabels, addLinks and removeLinks change part of it, safe beside another bot's edit (not together with labels or links). Moving to done or canceled stamps completedAt; reopening clears it.`,
      inputSchema: itemUpdateSchema.extend({ item }),
      annotations: update,
    },
    ({ item, assignee, ...patch }) =>
      run("update_item", () =>
        toIssue(
          service.updateItem(actor, item, { ...patch, assigneeId: assignee }),
        ),
      ),
  );

  server.registerTool(
    "list_items",
    {
      description:
        'List items newest first, filtered by any of product, project, type (todo or issue), status and assignee, a page at a time: pass nextCursor back as cursor until it is null. Your product\'s triage: product and status "triage". A project\'s open todos: project, type "todo" and status "open". Only items of products this key reaches are listed.',
      inputSchema: z.strictObject({
        product: product.optional(),
        project: projectSlug.optional(),
        type: itemListQuerySchema.shape.type,
        status: itemListQuerySchema.shape.status,
        assignee: itemListQuerySchema.shape.assignee,
        ...page,
      }),
      annotations: read,
    },
    (query) =>
      run("list_items", () => toPage(service.listItems(actor, query), toIssue)),
  );

  server.registerTool(
    "add_comment",
    {
      description:
        "Add a comment to an item, a todo or an issue, named by its key like TRL-12. On an issue in triage, comment to ask the filer a question before you accept or cancel it.",
      inputSchema: commentCreateSchema.extend({
        item: item.optional(),
        issueId: issueIdAlias,
        ...idempotencyKey,
      }),
      annotations: create,
    },
    ({ item, issueId, idempotency_key, ...input }) =>
      run("add_comment", () => {
        const ref = itemArg(item, issueId);
        return noted(
          toComment(
            service.addComment(
              actor,
              { ...input, issueId: ref.value },
              { idempotencyKey: idempotency_key },
            ),
          ),
          ref.note,
        );
      }),
  );

  server.registerTool(
    "list_comments",
    {
      description:
        "List an item's comments, oldest first, a page at a time: pass nextCursor back as cursor until it is null.",
      inputSchema: z.strictObject({
        item: item.optional(),
        issueId: issueIdAlias,
        ...page,
      }),
      annotations: read,
    },
    ({ item, issueId, ...query }) =>
      run("list_comments", () => {
        const ref = itemArg(item, issueId);
        return noted(
          toPage(service.listComments(actor, ref.value, query), toComment),
          ref.note,
        );
      }),
  );

  server.registerTool(
    "create_project",
    {
      description:
        "Create a project: a named group of items from one or more products, with a goal, a lead bot and an optional target date, then fill it with add_to_project. Needs the issues action on a key reaching every product named. products defaults to the one product you own (the error lists choices otherwise); lead defaults to you; slug is derived from the name when left out. Returns the project with its slug, which names it everywhere. Deprecated: called with key (and no slug, products, lead, goal or targetDate) it creates a product as it did before projects, and the result carries deprecated; use create_product for that.",
      inputSchema: projectCreateSchema.extend(idempotencyKey),
      annotations: create,
    },
    ({ idempotency_key, ...input }) =>
      run("create_project", () => {
        const found = service.createProjectOrProduct(actor, input, {
          idempotencyKey: idempotency_key,
        });
        return found.kind === "project"
          ? toProject(found.project)
          : deprecated(toProduct(found.product), deprecations.createProduct);
      }),
  );

  const projectArg = {
    project: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The project's slug, like launch-q4. Deprecated: a product key (like TRL) that matches no slug names that product, as before projects.",
      ),
    projectId: z
      .string()
      .min(1)
      .optional()
      .describe("Deprecated alias of project."),
  };
  const projectRef = (project?: string, projectId?: string) => {
    const ref = eitherOf(project, projectId, ["project", "projectId"]);
    if (ref.value === undefined) {
      throw new ValidationError(
        "project is required: send the project's slug, like launch-q4; list_projects lists them",
      );
    }
    return ref as { value: string; note: string | undefined };
  };
  const viewOf = (found: ProjectOrProduct, note: string | undefined) =>
    found.kind === "project"
      ? noted(toProject(found.project), note)
      : deprecated(toProduct(found.product), deprecations.product);

  server.registerTool(
    "get_project",
    {
      description:
        "Get a project by slug: goal, lead, target date, its products this key reaches (hiddenProducts true when it draws from others you can't see), item counts per status over the products shown, and its latest status update. List its items with list_items and project. Deprecated: a product key (like TRL) that matches no slug returns that product, carrying deprecated; use get_product for that.",
      inputSchema: z.strictObject(projectArg),
      annotations: read,
    },
    ({ project, projectId }) =>
      run("get_project", () => {
        const ref = projectRef(project, projectId);
        return viewOf(service.getProjectOrProduct(actor, ref.value), ref.note);
      }),
  );

  server.registerTool(
    "list_projects",
    {
      description:
        "List projects (named groups of items across products) newest first, a page at a time: pass nextCursor back as cursor until it is null. Only projects drawing from a product this key reaches are listed. Before this release list_projects listed products; call list_products for those.",
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
        "Change a project's name, goal, lead (a bot's name or id) or targetDate (YYYY-MM-DD, null clears). Fields left out stay as they are. Needs the issues action on a key reaching one of the project's products. Deprecated: a product key (like TRL) that matches no slug changes that product's name or description, carrying deprecated; use update_product for that.",
      inputSchema: projectUpdateSchema.extend(projectArg),
      annotations: update,
    },
    ({ project, projectId, ...patch }) =>
      run("update_project", () => {
        const ref = projectRef(project, projectId);
        return viewOf(
          service.updateProjectOrProduct(actor, ref.value, patch),
          ref.note,
        );
      }),
  );

  server.registerTool(
    "add_to_project",
    {
      description:
        "Add items to a project by key, up to 100 a call, from any products this key reaches: an item's product joins the project's products by itself. An item already in the project is left as it is and listed in unchanged, so a retry is safe. Needs the issues action on a key reaching one of the project's products. Returns the project with added and unchanged keys.",
      inputSchema: projectItemsSchema.extend({ project: projectSlug }),
      annotations: update,
    },
    ({ project, items }) =>
      run("add_to_project", () => {
        const result = service.addToProject(actor, project, items);
        return { ...result, project: toProject(result.project) };
      }),
  );

  server.registerTool(
    "remove_from_project",
    {
      description:
        "Take items out of a project by key, up to 100 a call; the items themselves stay as they are, and the project keeps its products. An item not in the project is listed in unchanged, so a retry is safe. Needs the issues action on a key reaching one of the project's products.",
      inputSchema: projectItemsSchema.extend({ project: projectSlug }),
      annotations: update,
    },
    ({ project, items }) =>
      run("remove_from_project", () => {
        const result = service.removeFromProject(actor, project, items);
        return { ...result, project: toProject(result.project) };
      }),
  );

  server.registerTool(
    "list_products",
    {
      description:
        "List the products this key reaches, newest first, a page at a time: pass nextCursor back as cursor until it is null. A product owns items (keys like TRL-12); its owner is its own bot, who adds its todos and accepts issues filed to it.",
      inputSchema: z.strictObject(page),
      annotations: read,
    },
    (query) =>
      run("list_products", () =>
        toPage(service.listProducts(actor, query), toProduct),
      ),
  );

  server.registerTool(
    "get_product",
    {
      description:
        "Get a product by key, like TRL: name, description, repoUrl and owner (its own bot).",
      inputSchema: z.strictObject({ product }),
      annotations: read,
    },
    ({ product }) =>
      run("get_product", () => toProduct(service.getProduct(actor, product))),
  );

  server.registerTool(
    "create_product",
    {
      description:
        "Create a product. Its key (like TRL) prefixes its items' keys (TRL-1, TRL-2, ...), must be unused and never changes. You own it unless owner names another bot. Needs the admin action and a key that reaches every product. To bring a product over from Linear, use import_project instead.",
      inputSchema: productCreateSchema.extend(idempotencyKey),
      annotations: create,
    },
    ({ idempotency_key, ...input }) =>
      run("create_product", () =>
        toProduct(
          service.createProduct(actor, input, {
            idempotencyKey: idempotency_key,
          }),
        ),
      ),
  );

  server.registerTool(
    "update_product",
    {
      description:
        "Change a product's name, description, repoUrl (https://github.com/<owner>/<name>, null clears) or owner (a bot's name or id, null clears). Fields left out stay as they are. Needs the admin action.",
      inputSchema: productUpdateSchema.extend({ product }),
      annotations: update,
    },
    ({ product, ...patch }) =>
      run("update_product", () =>
        toProduct(service.updateProduct(actor, product, patch)),
      ),
  );

  const statusTarget = {
    product: product.optional(),
    project: projectSlug.optional(),
    projectId: projectIdAlias,
  };
  /** The status target, `projectId` read as the product it named before projects. */
  const statusTargetOf = (args: {
    product?: string;
    project?: string;
    projectId?: string;
  }) => {
    const productRef = eitherOf(args.product, args.projectId, [
      "product",
      "projectId",
    ]);
    return {
      target: { product: productRef.value, project: args.project },
      note: productRef.note,
    };
  };

  server.registerTool(
    "post_status_update",
    {
      description:
        "Post a dated status update with its health (on_track, at_risk or off_track) on exactly one of a product (its key) or a project (its slug). Needs the status_updates action on a key reaching the product, or one of the project's products. externalRef is kept on a product's update only.",
      inputSchema: statusUpdateCreateSchema.extend({
        ...statusTarget,
        ...idempotencyKey,
      }),
      annotations: create,
    },
    ({ product, project, projectId, idempotency_key, ...input }) =>
      run("post_status_update", () => {
        const { target, note } = statusTargetOf({
          product,
          project,
          projectId,
        });
        return noted(
          toStatusUpdate(
            service.createStatusUpdate(
              actor,
              { ...input, ...target },
              { idempotencyKey: idempotency_key },
            ),
          ),
          note,
        );
      }),
  );

  server.registerTool(
    "list_status_updates",
    {
      description:
        "List the status updates of exactly one of a product (its key) or a project (its slug), newest first, a page at a time: pass nextCursor back as cursor until it is null.",
      inputSchema: z.strictObject({ ...statusTarget, ...page }),
      annotations: read,
    },
    ({ product, project, projectId, ...query }) =>
      run("list_status_updates", () => {
        const { target, note } = statusTargetOf({
          product,
          project,
          projectId,
        });
        return noted(
          toPage(
            service.listStatusUpdates(actor, target, query),
            toStatusUpdate,
          ),
          note,
        );
      }),
  );

  /** A product argument and its `projectId` alias, one of which is required. */
  const productArg = (value?: string, alias?: string) => {
    const ref = eitherOf(value, alias, ["product", "projectId"]);
    if (ref.value === undefined) {
      throw new ValidationError(
        "product is required: send the product's key, like TRL; list_products lists them",
      );
    }
    return ref as { value: string; note: string | undefined };
  };

  server.registerTool(
    "create_label",
    {
      description:
        "Create a label in a product. Naming a new label on add_todo, file_issue or update_item creates it too. Needs the admin action.",
      inputSchema: labelCreateSchema.extend({
        product: product.optional(),
        projectId: projectIdAlias,
        ...idempotencyKey,
      }),
      annotations: create,
    },
    ({ product, projectId, idempotency_key, ...input }) =>
      run("create_label", () => {
        const ref = productArg(product, projectId);
        return noted(
          toLabel(
            service.createLabel(
              actor,
              { ...input, productId: ref.value },
              { idempotencyKey: idempotency_key },
            ),
          ),
          ref.note,
        );
      }),
  );

  server.registerTool(
    "list_labels",
    {
      description:
        "List a product's labels, oldest first, a page at a time: pass nextCursor back as cursor until it is null.",
      inputSchema: z.strictObject({
        product: product.optional(),
        projectId: projectIdAlias,
        ...page,
      }),
      annotations: read,
    },
    ({ product, projectId, ...query }) =>
      run("list_labels", () => {
        const ref = productArg(product, projectId);
        return noted(
          toPage(service.listLabels(actor, ref.value, query), toLabel),
          ref.note,
        );
      }),
  );

  server.registerTool(
    "list_activity",
    {
      description:
        'Read the activity feed, optionally of one product (its key), one project (its slug: its own events and its items joining and leaving) or one actor. To follow it, pass after: "" for the first events, oldest first, then each page\'s nextCursor as after to get only newer events (never null; an empty page means nothing new yet). Without after, it pages newest first through cursor. A cursor only works with the filters it was issued under.',
      inputSchema: z.strictObject({
        after: activityListQuerySchema.shape.after,
        cursor: activityListQuerySchema.shape.cursor,
        limit: page.limit,
        product: product.optional(),
        project: projectSlug.optional(),
        projectId: projectIdAlias,
        actorId: activityListQuerySchema.shape.actorId,
      }),
      annotations: read,
    },
    ({ product, projectId, ...query }) =>
      run("list_activity", () => {
        const ref = eitherOf(product, projectId, ["product", "projectId"]);
        return noted(
          toPage(
            service.listActivity(actor, { ...query, product: ref.value }),
            toActivityEvent,
          ),
          ref.note,
        );
      }),
  );

  server.registerTool(
    "create_issue",
    {
      description: `${aliasOf("add_todo or file_issue")} Creates an item in the product projectId names (its key, like TRL): a todo when you own the product, else an issue in triage. The result carries deprecated.`,
      inputSchema: issueCreateSchema.extend(idempotencyKey),
      annotations: create,
    },
    ({ idempotency_key, ...input }) =>
      run("create_issue", () =>
        deprecated(
          toIssue(
            service.createIssue(actor, input, {
              idempotencyKey: idempotency_key,
            }),
          ),
          deprecations.createIssue,
        ),
      ),
  );

  server.registerTool(
    "get_issue",
    {
      description: `${aliasOf("get_item")} Gets an item by its key, like TRL-12.`,
      inputSchema: z.strictObject({ issueId: item }),
      annotations: read,
    },
    ({ issueId }) =>
      run("get_issue", () =>
        deprecated(
          toIssue(service.getItem(actor, issueId)),
          deprecations.getIssue,
        ),
      ),
  );

  server.registerTool(
    "list_issues",
    {
      description: `${aliasOf("list_items")} Lists items newest first; projectId takes a product's key.`,
      inputSchema: z.strictObject({
        projectId: projectIdAlias,
        status: issueListQuerySchema.shape.status,
        assigneeId: issueListQuerySchema.shape.assigneeId,
        ...page,
      }),
      annotations: read,
    },
    ({ projectId, assigneeId, ...query }) =>
      run("list_issues", () =>
        deprecated(
          toPage(
            service.listItems(actor, {
              ...query,
              product: projectId,
              assignee: assigneeId,
            }),
            toIssue,
          ),
          deprecations.listIssues,
        ),
      ),
  );

  server.registerTool(
    "update_issue",
    {
      description: `${aliasOf("update_item")} Changes an item named by issueId (its key, like TRL-12); assigneeId takes a bot's name or id.`,
      inputSchema: issueUpdateSchema.extend({ issueId: item }),
      annotations: update,
    },
    ({ issueId, ...patch }) =>
      run("update_issue", () =>
        deprecated(
          toIssue(service.updateItem(actor, issueId, patch)),
          deprecations.updateIssue,
        ),
      ),
  );

  server.registerTool(
    "whoami",
    {
      description:
        "Get the bot this key acts as: its id (the createdBy, authorId and actorId your writes carry), name, label, photoUrl (null until set_my_photo sets one), title (null until set_my_title sets one), ownProducts (the products whose own bot you are: add_todo goes there), products (every product this key reaches: file_issue on any of them), and the key's scope: the keys of the only products it reaches and the actions it may take (read, issues, comments, status_updates, admin), each null when unrestricted. Call it first to learn where your todos go.",
      inputSchema: z.strictObject({}),
      annotations: read,
    },
    () => run("whoami", () => toWhoami(service.whoami(actor), actor.scope)),
  );

  server.registerTool(
    "list_bots",
    {
      description:
        "List every bot, oldest first, with its id, name, label, photoUrl and title, a page at a time: pass nextCursor back as cursor until it is null. A bot's name or id is what assignee, lead and owner take. A createdBy, authorId or actorId that matches a bot's id was written by that bot; an id that matches no bot is a person's (people file issues and comment). Needs the admin action.",
      inputSchema: z.strictObject(page),
      annotations: read,
    },
    (query) =>
      run("list_bots", () => toPage(service.listBots(actor, query), toBot)),
  );

  server.registerTool(
    "set_my_photo",
    {
      description: `Set your own photo, which people see beside your name in trail. Send ${PHOTO_ACCEPTS}, ${photoEncoding} Its type is read from the bytes, and its pixel size from its header: a larger image is refused, not scaled. The whole image goes in this one argument, so send a small avatar: about 128x128px, under about 16 KB. For a larger file, send its raw bytes to PUT /api/v1/me/photo with this same key instead. A new photo replaces the old one and gets a new photoUrl. Every key may call this, whatever its scope.`,
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

  server.registerTool(
    "set_my_title",
    {
      description: `Set your own title: a short plain-text role, like "Release manager", that people see beside your name in trail. It is trimmed, then must be 1 to ${BOT_TITLE_MAX} characters. Setting the title you already have changes nothing. Every key may call this, whatever its scope.`,
      inputSchema: myTitleUpdateSchema,
      // the title it replaces is gone for good
      annotations: { ...update, destructiveHint: true },
    },
    ({ title }) => run("set_my_title", () => service.setMyTitle(actor, title)),
  );

  server.registerTool(
    "clear_my_title",
    {
      description:
        "Remove your own title; succeeds when you have none too. Every key may call this, whatever its scope.",
      inputSchema: z.strictObject({}),
      annotations: { ...update, destructiveHint: true },
    },
    () => run("clear_my_title", () => service.clearMyTitle(actor)),
  );

  const webhookId = z
    .string()
    .min(1)
    .describe("The webhook's id, from create_webhook or list_webhooks.");
  const ownWebhooks =
    "Acts on your own webhooks only; another bot's, or one following a product outside this key's scope, is not found.";

  server.registerTool(
    "create_webhook",
    {
      description: `Get a signed webhook call for every event in the products you follow (products: their keys), and in every project drawing from one of them, so you hear of an issue filed to your product without polling list_activity. projects is the deprecated alias of products. Needs the read action. ${WEBHOOK_SETUP} ${WEBHOOK_DELIVERY} Returns the webhook (never its secret); a product this key can't read is not found.`,
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
      description: `List your webhooks, oldest first, each with the products it follows, paused, lastSuccessAt, lastError and lastErrorAt: read it to see whether deliveries are healthy. The secret is never listed. Needs the read action. ${ownWebhooks}`,
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
      description: `Change a webhook's url or the products it follows (products replaces the whole list; projects is its deprecated alias), and resume it if it was paused: an update with no fields still resumes. Fields left out stay as they are. To change the secret use rotate_webhook_secret. Needs the read action. ${ownWebhooks}`,
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
        "Bring a whole Linear project (or another tracker's) over into a trail product in one call: the product with its items, their comments, labels and links, and its status updates, each keyed by externalRef (Linear's id, a UUID). Send each issue's sourceKey (Linear's identifier, like JUS-187): trail stores it, so JUS-187 finds the issue in get_item, update_item and add_comment from then on, and a new issue keeps that number when its prefix is the product's key. If that number is taken by another issue, the new one gets the product's next number and is listed in the result's renumbered with its new key; nothing fails. Use that new key for a renumbered issue: its sourceKey is the other issue's key, so it finds the other issue. Descriptions and comment bodies may be up to 1048576 characters and an issue may have up to 200 links. The payload is checked in two passes, and nothing is imported unless both pass. First its shape: a missing or unknown field, a value of the wrong type, the product's key, name, description or labels, and any row's externalRef, createdAt, completedAt, sourceAuthor or health; the error names every such failure by its path, like issues.3.createdAt. Then every other value; the error lists every failing row with its sourceKey or externalRef. Fix everything an error lists before sending the import again. Send each issue's statusType (Linear's state.type) and status (its state name, kept as sourceStatus): statusType maps backlog/unstarted/triage → open, started → in_progress, completed → done, canceled/duplicate → canceled; without it, status names map Backlog/Todo/Triage → open, In Progress → in_progress, Done → done, Canceled/Duplicate → canceled. Rows are matched by externalRef, so a re-run never duplicates; it sets each matched row's fields, labels and links to the payload's values, replacing changes made in trail since the last import, and never deletes rows. An imported issue's number never changes; a label that differs from the product's only by case is renamed to the payload's spelling. Imported items keep their imported status (never triage) and are typed todo when you own the product, else issue. Returns the product (project is its deprecated alias), per kind how many rows were created, updated and unchanged, and renumbered.",
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
