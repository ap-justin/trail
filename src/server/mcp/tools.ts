import { z } from "@hono/zod-openapi";
import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
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
  markReadSchema,
  messageCreateSchema,
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
import { COMMENT_HOLDS, TODO_OR_ISSUE } from "../api/items.js";
import { STATUS_UPDATE_HOLDS } from "../api/products.js";
import { LABEL_CREATORS } from "../api/routes.js";
import {
  deprecated,
  toActivityEvent,
  toBot,
  toComment,
  toCreatedComment,
  toImportResult,
  toInboxEntry,
  toIssue,
  toLabel,
  toLegacyIssue,
  toMarkReadResult,
  toMessage,
  toPage,
  toProduct,
  toProductRead,
  toProject,
  toSentMessage,
  toStatusUpdate,
  toWebhook,
  toWhoami,
  withSkippedLabels,
} from "../api/serialize.js";
import { actorPhotoContentTypes } from "../db/schema.js";
import {
  InvalidImageError,
  PayloadTooLargeError,
  ServiceError,
  ValidationError,
} from "../service/errors.js";
import {
  legacyProduct,
  type NamedProduct,
  type ProductView,
  type ProjectOrProduct,
  type Service,
  type WebhookWritten,
} from "../service/index.js";
import type { KeyActor } from "../service/keys.js";
import {
  MARK_READ_MAX,
  MESSAGE_PREVIEW_CHARS,
  MESSAGE_WINDOW_MS,
  MESSAGES_PER_PAIR,
} from "../service/messages.js";
import {
  PHOTO_ACCEPTS,
  PHOTO_MAX_BYTES,
  photoTooLarge,
} from "../service/photos.js";
import { BOT_TITLE_MAX } from "../service/validate.js";
import { PING_LIMIT, PING_WINDOW_MS } from "../service/webhooks.js";
import {
  WEBHOOK_DELIVERY,
  WEBHOOK_INBOX,
  WEBHOOK_SETUP,
} from "../webhooks/docs.js";
import { withArgumentHelp } from "./arguments.js";

const idempotencyKey = {
  idempotency_key: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "Makes the create safe to retry: a repeat with the same key and arguments returns the first result and saves nothing, while this key may still make that create and read what it made; otherwise the repeat gets the error a new create or a read would.",
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
/** A change that overwrites what was there: a client asking before destructive tools asks before these. */
const update: ToolAnnotations = {
  ...create,
  destructiveHint: true,
  idempotentHint: true,
};
/** A repeatable change that only adds. */
const additive: ToolAnnotations = { ...create, idempotentHint: true };

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

const inputSchemas = new Map<string, z.ZodObject>();

/**
 * The tool's input schema with its argument help, built on the first call and
 * reused: zod-to-openapi keeps every schema derived from one of ours (an
 * `extend` of a described schema) in a process-wide map for good, so a schema
 * built per request is a schema never freed.
 */
function inputSchemaOf<Schema extends z.ZodObject>(
  name: string,
  build: () => Schema,
): Schema {
  let schema = inputSchemas.get(name);
  if (schema === undefined) {
    schema = withArgumentHelp(name, build());
    inputSchemas.set(name, schema);
  }
  return schema as Schema;
}

/** Registers every trail tool on `server`, each acting as `actor` within its key's scope. */
export function registerTools(
  server: McpServer,
  service: Service,
  actor: KeyActor,
): void {
  // every tool registers through here, so each refuses an unknown argument with its own help
  const register = <Schema extends z.ZodObject>(
    name: string,
    config: {
      title?: string;
      description?: string;
      annotations?: ToolAnnotations;
      inputSchema: () => Schema;
    },
    callback: ToolCallback<Schema>,
  ) =>
    server.registerTool(
      name,
      { ...config, inputSchema: inputSchemaOf(name, config.inputSchema) },
      callback,
    );
  const item = z
    .string()
    .min(1)
    .describe(
      "The item's key, like TRL-12 (or its id, or the key it had in the system it was imported from, like ABC-187).",
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
  /** The note on an argument the schema leaves optional only because its deprecated alias may stand in. */
  const requiredUnless = (alias: string, description: string) =>
    `Required, unless you send ${alias}, its deprecated alias. ${description}`;
  const aliasedItem = z
    .string()
    .min(1)
    .optional()
    .describe(
      requiredUnless(
        "issueId",
        "The item's key, like TRL-12 (or its id, or the key it had in the system it was imported from, like ABC-187).",
      ),
    );
  const aliasedProduct = z
    .string()
    .min(1)
    .optional()
    .describe(
      requiredUnless(
        "projectId",
        "The product's key, like TRL (any case); list_products lists those this key reaches.",
      ),
    );

  register(
    "add_todo",
    {
      description: `Add a todo: planned work in a product you own, or in a product with no owner. ${TODO_OR_ISSUE} In a product another bot owns this is refused (forbidden, naming the owner): use file_issue instead to report a bug or ask for work there. Without product it goes to the one product you own; with none or several, the error lists the products to pick from. Label names match the product's labels ignoring the case of A-Z, and a new name creates the label. Returns the item with its key, like TRL-12.`,
      inputSchema: () => todoCreateSchema.extend(idempotencyKey),
      annotations: create,
    },
    ({ idempotency_key, ...input }) =>
      run("add_todo", () =>
        toIssue(
          service.addTodo(actor, input, { idempotencyKey: idempotency_key }),
        ),
      ),
  );

  register(
    "file_issue",
    {
      description: `File an issue: a bug report or request to a product's bot, on any product list_products lists. With project (a slug list_projects lists) the issue joins that project in the same call; product must be one the project draws from, and left out it is the project's one product. A key reaching a product only through projects sends \`project\` when it names more than one; with exactly one, that one is the default. ${TODO_OR_ISSUE} Use add_todo instead for planned work in your own product. Leave assignee out: the product's bot assigns it when it accepts the issue (status open with assignee). On a product another bot owns, labels attach only the product's existing labels (list_labels lists them) and create none; the result lists the names it left off in skippedLabels. Returns the item with its key, like TRL-12, in status triage.`,
      inputSchema: () => issueFileSchema.extend(idempotencyKey),
      annotations: create,
    },
    ({ idempotency_key, ...input }) =>
      run("file_issue", () => {
        const filed = service.fileIssue(actor, input, {
          idempotencyKey: idempotency_key,
        });
        return withSkippedLabels(toIssue(filed), filed);
      }),
  );

  register(
    "get_item",
    {
      description:
        "Get an item (a todo or an issue) by its key, like TRL-12: type, product, status, assignee, labels, links, the projects it is in, and access, why this key reaches it: product (its products cover it), project (a project the key lists holds it) or via_project (a project drawing from one of the key's products holds it: read it and comment with add_comment, and any change is refused until the key lists its product or project).",
      inputSchema: () => z.strictObject({ item }),
      annotations: read,
    },
    ({ item }) => run("get_item", () => toIssue(service.getItem(actor, item))),
  );

  register(
    "update_item",
    {
      description: `Change an item: type, status, assignee, priority, labels, title, description, estimate or links. ${TODO_OR_ISSUE} To accept an issue from your product's triage send status open with assignee, the bot that will work on it (often you), since status open alone leaves it unassigned; or send type todo, which opens it and assigns the product's owner when it has no assignee. To drop it send status canceled. On a product with an owner, only the owner accepts its triage issues, reopens a canceled issue another bot filed, and changes any item's type, and only the owner or the item's filer cancels it, at any status; anyone else is refused (forbidden) and should comment with add_comment to ask the owner. An item get_item shows with access via_project takes no change at all (forbidden_scope): comment on it instead, and the refusal names whom to ask for a grant. A todo never goes back to triage and never loses its assignee. Fields left out stay as they are. labels or links replace the whole set; addLabels, removeLabels, addLinks and removeLinks change part of it, safe beside another bot's edit (not together with labels or links). On a product another bot owns, labels and addLabels attach only the product's existing labels (list_labels lists them) and create none; the result lists the names it left off in skippedLabels. Moving to done or canceled stamps completedAt; reopening clears it.`,
      inputSchema: () => itemUpdateSchema.extend({ item }),
      annotations: update,
    },
    ({ item, assignee, ...patch }) =>
      run("update_item", () => {
        const updated = service.updateItem(actor, item, {
          ...patch,
          assigneeId: assignee,
        });
        return withSkippedLabels(toIssue(updated), updated);
      }),
  );

  register(
    "list_items",
    {
      description:
        'List items newest first, filtered by any of product, project, type (todo or issue), status and assignee, a page at a time: pass nextCursor back as cursor until it is null. Your product\'s triage: product and status "triage". A project\'s open todos: project, type "todo" and status "open". Only items this key reaches are listed: every item of its products, and the items of its projects and of the projects drawing from its products, whichever product they are in (list_projects lists them; send project for the items of one).',
      inputSchema: () =>
        z.strictObject({
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

  register(
    "add_comment",
    {
      description: `Add a comment to an item, a todo or an issue, named by its key like TRL-12, including one this key reads only through a project (access via_project). ${COMMENT_HOLDS} The result carries hint when the body reads like a build log. On an issue in triage, comment to ask the filer a question before you accept or cancel it.`,
      inputSchema: () =>
        commentCreateSchema.extend({
          item: aliasedItem,
          issueId: issueIdAlias,
          ...idempotencyKey,
        }),
      annotations: create,
    },
    ({ item, issueId, idempotency_key, ...input }) =>
      run("add_comment", () => {
        const ref = itemArg(item, issueId);
        return noted(
          toCreatedComment(
            service.addComment(
              actor,
              { ...input, issueId: ref.value },
              { idempotencyKey: idempotency_key },
            ),
            "mcp",
          ),
          ref.note,
        );
      }),
  );

  register(
    "list_comments",
    {
      description:
        "List an item's comments, oldest first, a page at a time: pass nextCursor back as cursor until it is null.",
      inputSchema: () =>
        z.strictObject({
          item: aliasedItem,
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

  register(
    "create_project",
    {
      description:
        "Create a project: a named group of items from one or more products, with a goal, a lead bot and an optional target date, then fill it with add_to_project. Needs the issues action on a key reaching every product named. products defaults to the one product you own (the error lists choices otherwise); lead defaults to you; slug is derived from the name when left out. Returns the project with its slug, which names it everywhere. Deprecated: called with key (and no slug, products, lead, goal or targetDate) it creates a product as it did before projects, and the result carries deprecated; use create_product for that. A product stays for good, since no tool deletes a product: send key only when you mean to create one.",
      inputSchema: () => projectCreateSchema.extend(idempotencyKey),
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
        requiredUnless(
          "projectId",
          "The project's slug, like launch-q4. Deprecated: a product key (like TRL) that matches no slug names that product, as before projects.",
        ),
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
  const viewOf = (
    found: ProjectOrProduct<ProductView | NamedProduct>,
    note: string | undefined,
  ) =>
    found.kind === "project"
      ? noted(toProject(found.project), note)
      : deprecated(toProductRead(found.product), deprecations.product);

  register(
    "get_project",
    {
      description:
        "Get a project by slug: goal, lead, target date, its products this key reaches (hiddenProducts true when it draws from others you can't see), item counts per status over the products shown, and its latest status update. List its items with list_items and project. Deprecated: a product key (like TRL) that matches no slug returns that product, carrying deprecated; use get_product for that.",
      inputSchema: () => z.strictObject(projectArg),
      annotations: read,
    },
    ({ project, projectId }) =>
      run("get_project", () => {
        const ref = projectRef(project, projectId);
        return viewOf(service.getProjectOrProduct(actor, ref.value), ref.note);
      }),
  );

  register(
    "list_projects",
    {
      description:
        "List the projects this key reaches (named groups of items across products), newest first, a page at a time: pass nextCursor back as cursor until it is null. They are the projects its key names and those drawing from a product it reaches. list_items with project lists a project's items, and file_issue with project files an issue into one. Before this release list_projects listed products; call list_products for those. The result carries deprecated for one release.",
      inputSchema: () => z.strictObject(page),
      annotations: read,
    },
    (query) =>
      run("list_projects", () =>
        deprecated(
          toPage(service.listProjects(actor, query), toProject),
          deprecations.listProjects,
        ),
      ),
  );

  register(
    "update_project",
    {
      description:
        "Change a project's name, goal, lead (a bot's name or id) or targetDate (YYYY-MM-DD, null clears). Fields left out stay as they are. Needs the issues action on a key reaching one of the project's products. Deprecated: a product key (like TRL) that matches no slug changes that product's name or description, carrying deprecated; use update_product for that.",
      inputSchema: () => projectUpdateSchema.extend(projectArg),
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

  register(
    "add_to_project",
    {
      description:
        "Add items to a project by key, up to 100 a call, from any products this key reaches: an item's product joins the project's products by itself, when the key lists that product or its bot owns it, and is refused (forbidden_scope) otherwise. An item already in the project is left as it is and listed in unchanged, so a retry is safe. Needs the issues action on a key reaching one of the project's products; an item the key reads only through a project (access via_project) is refused. Returns the project with added and unchanged keys.",
      inputSchema: () => projectItemsSchema.extend({ project: projectSlug }),
      annotations: additive,
    },
    ({ project, items }) =>
      run("add_to_project", () => {
        const result = service.addToProject(actor, project, items);
        return { ...result, project: toProject(result.project) };
      }),
  );

  register(
    "remove_from_project",
    {
      description:
        "Take items out of a project by key, up to 100 a call; the items themselves stay as they are, and the project keeps its products. From a project the key doesn't list, it removes only items of the products it lists or its bot owns, and refuses the rest (forbidden_scope). An item not in the project is listed in unchanged, so a retry is safe. Needs the issues action on a key reaching one of the project's products; an item the key reads only through a project (access via_project) is refused.",
      inputSchema: () => projectItemsSchema.extend({ project: projectSlug }),
      annotations: update,
    },
    ({ project, items }) =>
      run("remove_from_project", () => {
        const result = service.removeFromProject(actor, project, items);
        return { ...result, project: toProject(result.project) };
      }),
  );

  register(
    "list_products",
    {
      description:
        "List the products this key can name, newest first, a page at a time: pass nextCursor back as cursor until it is null. A product owns items (keys like TRL-12); its owner is its own bot, who adds its todos and accepts issues filed to it. It lists the products this key reaches, plus every product its projects, or the projects drawing from its products, draw from; of a product it reaches only through a project it reads only the id, key and name. When the key lists that project, list_labels lists the product's labels and file_issue with project files issues on it; through a project drawing from its products, it reads no labels and files nothing. A product carries no item counts.",
      inputSchema: () => z.strictObject(page),
      annotations: read,
    },
    (query) =>
      run("list_products", () =>
        toPage(service.listProducts(actor, query), toProductRead),
      ),
  );

  register(
    "get_product",
    {
      description:
        "Get a product by key, like TRL: name, description, repoUrl and owner (its own bot), and no item counts. A product this key reaches only through a project reads as its id, key and name only. When the key lists that project, list_labels lists the product's labels and file_issue with project files issues on it; through a project drawing from its products, it reads no labels and files nothing.",
      inputSchema: () => z.strictObject({ product }),
      annotations: read,
    },
    ({ product }) =>
      run("get_product", () =>
        toProductRead(service.getProduct(actor, product)),
      ),
  );

  register(
    "create_product",
    {
      description:
        "Create a product. Its key (like TRL) prefixes its items' keys (TRL-1, TRL-2, ...), must be unused and never changes. You own it unless owner names another bot. Needs the admin action and a key that reaches every product. To bring a product over from Linear, use import_project instead.",
      inputSchema: () => productCreateSchema.extend(idempotencyKey),
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

  register(
    "update_product",
    {
      description:
        "Change a product's name, description, repoUrl (https://github.com/<owner>/<name>, null clears) or owner (a bot's name or id, null clears). Fields left out stay as they are. Needs the admin action. A product's owner changes only when it has none or the caller is its owner, who may hand it to another bot or clear it; anyone else gets a 403 (forbidden) naming the owner, and the operator reassigns it with `trail products set-owner`.",
      inputSchema: () => productUpdateSchema.extend({ product }),
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

  register(
    "post_status_update",
    {
      description: `Post a dated status update with its health (on_track, at_risk or off_track) on exactly one of a product (its key) or a project (its slug). ${STATUS_UPDATE_HOLDS} Needs the status_updates action on a key reaching the product, or one of the project's products. externalRef is kept on a product's update only, and refused on a project's: send idempotency_key there to make the post safe to retry.`,
      inputSchema: () =>
        statusUpdateCreateSchema.extend({
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

  register(
    "list_status_updates",
    {
      description:
        "List the status updates of exactly one of a product (its key) or a project (its slug), newest first, a page at a time: pass nextCursor back as cursor until it is null.",
      inputSchema: () => z.strictObject({ ...statusTarget, ...page }),
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

  register(
    "create_label",
    {
      description: `Create a label in a product. ${LABEL_CREATORS} Needs the admin action.`,
      inputSchema: () =>
        labelCreateSchema.extend({
          product: aliasedProduct,
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

  register(
    "list_labels",
    {
      description:
        "List a product's labels, oldest first, a page at a time: pass nextCursor back as cursor until it is null. A product this key names only through a project drawing from its products is not found here, with a message naming that project and the grants that would list its labels; through a project the key lists, its labels are listed.",
      inputSchema: () =>
        z.strictObject({
          product: aliasedProduct,
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

  register(
    "list_activity",
    {
      description:
        'Read the activity feed, optionally of one product (its key), one project (its slug: its own events and its items joining and leaving) or one actor. To follow it, pass after: "" for the first events, oldest first, then each page\'s nextCursor as after to get only newer events (never null; an empty page means nothing new yet). Without after, it pages newest first through cursor. A cursor only works with the filters it was issued under.',
      inputSchema: () =>
        z.strictObject({
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

  register(
    "create_issue",
    {
      description: `${aliasOf("add_todo or file_issue")} Creates an item in the product projectId (or its alias project or product) names (its key, like TRL): a todo when you own the product, else an issue in triage. The result carries deprecated.`,
      inputSchema: () => issueCreateSchema.extend(idempotencyKey),
      annotations: create,
    },
    ({ idempotency_key, ...input }) =>
      run("create_issue", () => {
        const created = service.createIssue(actor, input, {
          idempotencyKey: idempotency_key,
        });
        return deprecated(
          withSkippedLabels(toLegacyIssue(created), created),
          deprecations.createIssue,
        );
      }),
  );

  register(
    "get_issue",
    {
      description: `${aliasOf("get_item")} Gets an item by its key, like TRL-12.`,
      inputSchema: () => z.strictObject({ issueId: item }),
      annotations: read,
    },
    ({ issueId }) =>
      run("get_issue", () =>
        deprecated(
          toLegacyIssue(service.getItem(actor, issueId)),
          deprecations.getIssue,
        ),
      ),
  );

  register(
    "list_issues",
    {
      description: `${aliasOf("list_items")} Lists items newest first; projectId (or its alias project or product) takes a product's key, and status open also lists issues waiting in triage (list_items matches status exactly).`,
      inputSchema: () =>
        z.strictObject({
          projectId: issueListQuerySchema.shape.projectId,
          project: issueListQuerySchema.shape.project,
          product: issueListQuerySchema.shape.product,
          status: issueListQuerySchema.shape.status,
          assigneeId: issueListQuerySchema.shape.assigneeId,
          ...page,
        }),
      annotations: read,
    },
    ({ projectId, project, product, assigneeId, ...query }) =>
      run("list_issues", () =>
        deprecated(
          toPage(
            service.listIssues(actor, {
              ...query,
              product: legacyProduct({ projectId, project, product }),
              assignee: assigneeId,
            }),
            toLegacyIssue,
          ),
          deprecations.listIssues,
        ),
      ),
  );

  register(
    "update_issue",
    {
      description: `${aliasOf("update_item")} Changes an item named by issueId (its key, like TRL-12); assigneeId takes a bot's name or id.`,
      inputSchema: () => issueUpdateSchema.extend({ issueId: item }),
      annotations: update,
    },
    ({ issueId, ...patch }) =>
      run("update_issue", () => {
        const updated = service.updateItem(actor, issueId, patch, {
          legacy: true,
        });
        return deprecated(
          withSkippedLabels(toLegacyIssue(updated), updated),
          deprecations.updateIssue,
        );
      }),
  );

  register(
    "whoami",
    {
      description:
        "Get the bot this key acts as: its id (the createdBy, authorId and actorId your writes carry), name, label, photoUrl (null until set_my_photo sets one), title (null until set_my_title sets one), unreadMessages (messages other bots sent you, unread: list_inbox lists them), ownProducts (the products whose own bot you are: add_todo goes there), products (every product this key files issues on: those it reaches, and those its projects draw from, which it files on with file_issue with project), and the key's scope: products (the keys of the products whose every item it reaches), projects (the slugs of the projects whose items it reaches, whichever product they are in) and actions (read, issues, comments, status_updates, admin), each null when unrestricted; and impliedProjects (the slugs of the projects drawing from one of the key's products that scope doesn't list: it reads and comments on their items in other products, and changes none of them; their other products show their name and key only, never their labels). Call it first to learn where your todos go.",
      inputSchema: () => z.strictObject({}),
      annotations: read,
    },
    () => run("whoami", () => toWhoami(service.whoami(actor), actor.scope)),
  );

  register(
    "list_bots",
    {
      description:
        "List every bot, oldest first, with its id, name, label, photoUrl and title, a page at a time: pass nextCursor back as cursor until it is null. A bot's name or id is what assignee, lead and owner take. A createdBy, authorId or actorId that matches a bot's id was written by that bot; an id that matches no bot is a person's (people file issues and comment). Needs the admin action.",
      inputSchema: () => z.strictObject(page),
      annotations: read,
    },
    (query) =>
      run("list_bots", () => toPage(service.listBots(actor, query), toBot)),
  );

  register(
    "set_my_photo",
    {
      description: `Set your own photo, which people see beside your name in trail. Send ${PHOTO_ACCEPTS}, ${photoEncoding} Its type is read from the bytes, and its pixel size from its header: a larger image is refused, not scaled. The whole image goes in this one argument, so send a small avatar: about 128x128px, under about 16 KB. For a larger file, send its raw bytes to PUT /api/v1/me/photo with this same key instead. A new photo replaces the old one and gets a new photoUrl. Every key may call this, whatever its scope.`,
      inputSchema: () =>
        z.strictObject({
          data: z.string().describe(`The image, ${photoEncoding}`),
        }),
      // the photo it replaces is gone for good
      annotations: update,
    },
    ({ data }) =>
      run("set_my_photo", () => service.setMyPhoto(actor, photoBytes(data))),
  );

  register(
    "clear_my_photo",
    {
      description:
        "Remove your own photo; succeeds when you have none too. Every key may call this, whatever its scope.",
      inputSchema: () => z.strictObject({}),
      annotations: update,
    },
    () => run("clear_my_photo", () => service.clearMyPhoto(actor)),
  );

  register(
    "set_my_title",
    {
      description: `Set your own title: a short plain-text role, like "Release manager", that people see beside your name in trail. It is trimmed, then must be 1 to ${BOT_TITLE_MAX} characters. Setting the title you already have changes nothing. Every key may call this, whatever its scope.`,
      inputSchema: () => myTitleUpdateSchema,
      // the title it replaces is gone for good
      annotations: update,
    },
    ({ title }) => run("set_my_title", () => service.setMyTitle(actor, title)),
  );

  register(
    "clear_my_title",
    {
      description:
        "Remove your own title; succeeds when you have none too. Every key may call this, whatever its scope.",
      inputSchema: () => z.strictObject({}),
      annotations: update,
    },
    () => run("clear_my_title", () => service.clearMyTitle(actor)),
  );

  const messageId = z
    .string()
    .min(1)
    .describe(
      "The id of a message you sent or received, from list_inbox, message_bot or a trail.message.received webhook.",
    );

  register(
    "message_bot",
    {
      description: `Send a direct message to another bot: a question, a status, a handoff. Only you and that bot can read it; it never appears in items, the feed or activity, and people can't receive messages. to takes a bot's name (any case) or id, not its label. To answer a message, pass its id as replyTo (to can then be left out): the reply joins that message's thread. expectsReply defaults to true; send false for an FYI, and the recipient can't reply to it. text is markdown. Returns the message (id, threadId, from, to) and its thread's messageCount. Refused: to naming a person, yourself or an unknown bot (list_bots lists bots); replyTo that isn't one of your messages, or that belongs to your conversation with another bot; a reply to a message sent with expectsReply false (no_reply_wanted: if it really must be said, send a new message without replyTo); text over 64 KiB; more than ${MESSAGES_PER_PAIR} messages to one bot in ${MESSAGE_WINDOW_MS / 60_000} minutes (rate_limited, saying how many seconds to wait). Any key may send, whatever its actions and products.`,
      inputSchema: () => messageCreateSchema.extend(idempotencyKey),
      annotations: create,
    },
    ({ idempotency_key, ...input }) =>
      run("message_bot", () =>
        toSentMessage(
          service.sendMessage(actor, input, {
            idempotencyKey: idempotency_key,
          }),
        ),
      ),
  );

  register(
    "list_inbox",
    {
      description: `List the messages other bots sent you, newest first: only unread ones unless all is true. Each entry has id, from (name and id), threadId, replyTo, expectsReply, createdAt, readAt, and preview, the first ${MESSAGE_PREVIEW_CHARS} characters of the text (truncated is true when there is more). Read the whole text and the rest of the conversation with get_thread, answer with message_bot and replyTo set to the message's id (unless expectsReply is false), then mark_read. Messages you sent are not listed: get_thread shows them. To be woken when a message arrives instead of polling, create_webhook with kind inbox. Pass nextCursor back as cursor, with the same all, for the next page.`,
      inputSchema: () =>
        z.strictObject({
          all: z
            .boolean()
            .optional()
            .describe("true lists read messages too; default false."),
          ...page,
        }),
      annotations: read,
    },
    (query) =>
      run("list_inbox", () =>
        toPage(service.listInbox(actor, query), toInboxEntry),
      ),
  );

  register(
    "get_thread",
    {
      description:
        "Read a conversation: every message in the thread of messageId (any message in it, or its threadId), oldest first, each with its whole text, from, to, replyTo, expectsReply, createdAt and readAt (when its recipient marked it read), plus the thread's two bots. A thread is one chain of replies: a message sent without replyTo starts a new one, even to the same bot. Only those two bots can read it: any other id is not found. Reading marks nothing read: call mark_read for that. Pass nextCursor back as cursor for the next page.",
      inputSchema: () => z.strictObject({ messageId, ...page }),
      annotations: read,
    },
    ({ messageId, ...query }) =>
      run("get_thread", () => {
        const thread = service.getThread(actor, messageId, query);
        return {
          threadId: thread.threadId,
          bots: thread.bots,
          ...toPage(thread, toMessage),
        };
      }),
  );

  register(
    "mark_read",
    {
      description: `Mark messages sent to you as read, so list_inbox stops listing them (all true still does). Takes 1 to ${MARK_READ_MAX} message ids from list_inbox and is safe to repeat. Each id gets its own result: read (marked now), already_read, or not_found (no message with that id was sent to you; one you sent counts as not found). Returns the results and unreadMessages, your unread count after the call.`,
      inputSchema: () => markReadSchema,
      annotations: additive,
    },
    ({ messageIds }) =>
      run("mark_read", () =>
        toMarkReadResult(service.markRead(actor, messageIds)),
      ),
  );

  const webhookId = z
    .string()
    .min(1)
    .describe("The webhook's id, from create_webhook or list_webhooks.");
  const writtenWebhook = (hook: WebhookWritten) =>
    noted(
      toWebhook(hook),
      hook.productAlias ? deprecations.webhookProjects : undefined,
    );
  const ownWebhooks =
    "Acts on your own webhooks only; another bot's, or one following a product outside this key's products or a project this key neither lists nor reaches through its products, is not found.";

  register(
    "create_webhook",
    {
      description: `Get signed webhook calls, of one of two kinds. kind inbox (no products): wake on each message another bot sends you, instead of polling list_inbox; it is always your own inbox. kind activity (the default): every event in the products you follow (products: their keys), and in every project drawing from one of them, so you hear of an issue filed to your product without polling list_activity; and the events of the projects you follow (projects: the slugs of projects this key lists or that draw from one of its products, or any project on an unrestricted key) and of the items in them while they are in them; a product key in projects (like TRL) still follows that product, as the deprecated alias of products did, and the result carries deprecated. It needs the read action and at least one product or project; a key that reaches exactly one project and no product follows that project when both are left out. ${WEBHOOK_INBOX} ${WEBHOOK_SETUP} ${WEBHOOK_DELIVERY} Returns the webhook (never its secret); a product outside this key's products, or a project it neither lists nor reaches through its products, is not found.`,
      inputSchema: () => webhookCreateSchema,
      annotations: create,
    },
    (input) =>
      runAsync("create_webhook", async () =>
        writtenWebhook(await service.createWebhook(actor, input)),
      ),
  );

  register(
    "list_webhooks",
    {
      description: `List your webhooks, oldest first, each with the products and projects it follows, paused, lastSuccessAt, lastError and lastErrorAt: read it to see whether deliveries are healthy. lastError is the last failure: what a failed attempt got, like HTTP 500, or why a delivery was not sent, with no attempt made, like "not sent: this webhook's key is revoked". The secret is never listed. A key without the read action lists only your inbox webhooks. ${ownWebhooks}`,
      inputSchema: () => z.strictObject({}),
      annotations: read,
    },
    () =>
      run("list_webhooks", () =>
        toPage(service.listWebhooks(actor), toWebhook),
      ),
  );

  register(
    "update_webhook",
    {
      description: `Change a webhook's url or what it follows (products replaces the whole list of product keys, projects the whole list of project slugs, a product key there being the deprecated alias of products; an activity webhook keeps at least one), and resume it if it was paused: an update with no fields still resumes. Fields left out stay as they are. To change the secret use rotate_webhook_secret. Needs the read action, except on an inbox webhook. ${ownWebhooks}`,
      inputSchema: () => webhookUpdateSchema.extend({ webhookId }),
      annotations: update,
    },
    ({ webhookId, ...patch }) =>
      runAsync("update_webhook", async () =>
        writtenWebhook(await service.updateWebhook(actor, webhookId, patch)),
      ),
  );

  register(
    "rotate_webhook_secret",
    {
      description: `Replace a webhook's signing secret, and resume it if it was paused. The old secret stops signing at once, so give your routine the new one first. Read the secret from a key in a script, never from chat; it is never returned. Needs the read action, except on an inbox webhook. ${ownWebhooks}`,
      inputSchema: () => webhookSecretUpdateSchema.extend({ webhookId }),
      annotations: update,
    },
    ({ webhookId, secret }) =>
      run("rotate_webhook_secret", () =>
        toWebhook(service.rotateWebhookSecret(actor, webhookId, secret)),
      ),
  );

  register(
    "delete_webhook",
    {
      description: `Delete a webhook and the deliveries still queued for it. Needs the read action, except on an inbox webhook. ${ownWebhooks}`,
      inputSchema: () => z.strictObject({ webhookId }),
      annotations: update,
    },
    ({ webhookId }) =>
      run("delete_webhook", () => service.deleteWebhook(actor, webhookId)),
  );

  register(
    "test_webhook",
    {
      description: `Send one signed trail.ping to a webhook now and see what its receiver answered: delivered, the HTTP status, and an error when it failed. Run it after create_webhook to check your OpenBot routine accepts the signature, and after a pause before you update the webhook. A webhook takes ${PING_LIMIT} tests per ${PING_WINDOW_MS / 1000} seconds; past that a test is refused as rate_limited with the seconds to wait. Needs the read action, except on an inbox webhook. ${ownWebhooks}`,
      inputSchema: () => z.strictObject({ webhookId }),
      annotations: { ...create, openWorldHint: true },
    },
    ({ webhookId }) =>
      runAsync("test_webhook", () => service.testWebhook(actor, webhookId)),
  );

  register(
    "import_project",
    {
      description:
        "Bring a whole Linear project (or another tracker's) over into a trail product in one call: the product with its items, their comments, labels and links, and its status updates, each keyed by externalRef (Linear's id, a UUID). Send each issue's sourceKey (the key it had in the tracker it comes from, like ABC-187): trail stores it, so ABC-187 finds the issue in get_item, update_item and add_comment from then on, and a new issue keeps that number when its prefix is the product's key. If that number is taken by another issue, the new one gets the product's next number and is listed in the result's renumbered with its new key; nothing fails. Use that new key for a renumbered issue: its sourceKey is the other issue's key, so it finds the other issue. Descriptions and comment bodies may be up to 1048576 characters and an issue may have up to 200 links. The payload is checked in two passes, and nothing is imported unless both pass. First its shape: a missing or unknown field, a value of the wrong type, the product's key, name, description or labels, and any row's externalRef, createdAt, completedAt, sourceAuthor or health; the error names every such failure by its path, like issues.3.createdAt. Then every other value; the error lists every failing row with its sourceKey or externalRef. Fix everything an error lists before sending the import again. Send each issue's statusType (Linear's state.type) and status (its state name, kept as sourceStatus): statusType maps backlog/unstarted/triage → open, started → in_progress, completed → done, canceled/duplicate → canceled; without it, status names map Backlog/Todo/Triage → open, In Progress → in_progress, Done → done, Canceled/Duplicate → canceled. Rows are matched by externalRef, so a re-run never duplicates; it sets each matched row's fields, labels and links to the payload's values, replacing changes made in trail since the last import, and never deletes rows. An imported issue's number never changes; a label that differs from the product's only by case is renamed to the payload's spelling. A product the import creates is owned by you; an existing product another bot owns is refused (forbidden), since only its owner imports into it. Imported items keep their imported status (never triage) and are typed todo when you own the product, else issue. Returns the product (project is its deprecated alias), per kind how many rows were created, updated and unchanged (products counted under products; projects is its deprecated alias), and renumbered.",
      inputSchema: () => importSchema,
      // a re-run overwrites bots' edits to matched rows
      annotations: update,
    },
    (payload) =>
      run("import_project", () =>
        toImportResult(service.importProject(actor, payload)),
      ),
  );
}
