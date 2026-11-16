import { z } from "@hono/zod-openapi";
import {
  activitySubjectTypes,
  actorKinds,
  apiKeyActions,
  issueStatuses,
  issueTypes,
  projectHealths,
} from "../server/db/schema.js";
import {
  IMPORT_LINKS_MAX,
  IMPORT_TEXT_MAX,
  sourceStateTypes,
} from "../server/service/import.js";
import {
  BOT_TITLE_MAX,
  botTitleCharacterProblem,
  ISSUE_LABELS_MAX,
  ISSUE_LINKS_MAX,
  SLUG_MAX,
} from "../server/service/validate.js";
import {
  WEBHOOK_PRODUCTS_MAX,
  WEBHOOK_SECRET_MAX,
  WEBHOOK_SECRET_MIN,
} from "../server/service/webhooks.js";

// Field docs go in .meta(), which both the OpenAPI spec and the MCP tools' JSON
// Schema read; .openapi({ description }) reaches only the spec.
const issueStatusSchema = z.enum(issueStatuses).openapi("IssueStatus");
const itemTypeSchema = z.enum(issueTypes).openapi("ItemType");
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

const actorRefSchema = z
  .object({ id, name: z.string(), kind: z.enum(actorKinds) })
  .openapi("ActorRef");

/** The note a response carries when it came through a deprecated tool, route or field. */
const deprecatedNote = z.string().meta({
  description:
    "Present when the call used a deprecated tool, route or field: names its replacement. Switch to that before the next release removes the old one.",
  example: "create_issue is deprecated: use add_todo or file_issue",
});

export const productSchema = z
  .object({
    id,
    key: z.string().meta({
      description: "Prefixes its items' keys, as in TRL-12.",
      example: "TRL",
    }),
    name: z.string(),
    description: z.string(),
    repoUrl: z.string().nullable().meta({
      description: "The product's GitHub repository; null when unset.",
      example: "https://github.com/acme/trail",
    }),
    owner: actorRefSchema.nullable().meta({
      description:
        "The product's own bot: it adds the product's todos and accepts issues from triage. Null when the product has none.",
    }),
    externalRef: z.string().nullable(),
    createdBy: id,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi("Product");

export const legacyProductSchema = productSchema
  .extend({ deprecated: deprecatedNote })
  .openapi("LegacyProduct");

const productRefSchema = z
  .object({ key: z.string(), name: z.string() })
  .openapi("ProductRef");

export const issueSchema = z
  .object({
    id,
    key: z.string().meta({
      description: "The product's key and the item's number.",
      example: "TRL-12",
    }),
    number: z.int().meta({ example: 12 }),
    type: itemTypeSchema.meta({
      description:
        "todo: planned work of the product's own bot, open from the start and always assigned. issue: a report to the product's bot, filed in triage until that bot accepts it (status open) or cancels it.",
    }),
    product: z.string().meta({
      description: "The key of the product the item belongs to.",
      example: "TRL",
    }),
    project: z.string().meta({
      description:
        "Deprecated alias of product (the product's key), kept for one release; projects lists the projects the item is in.",
      example: "TRL",
    }),
    projects: z
      .array(z.object({ slug: z.string(), name: z.string() }))
      .meta({ description: "The projects the item is in, by slug A to Z." }),
    sourceKey: z.string().nullable().meta({
      description:
        "On an imported item, its key in the system it came from, uppercased (like JUS-187). Any argument or path that takes the item's id or key takes this too.",
      example: "JUS-187",
    }),
    projectId: id.meta({ description: "Deprecated: the product's id." }),
    title: z.string(),
    description: z.string(),
    status: issueStatusSchema,
    priority,
    estimate: estimate.nullable(),
    labels: z.array(z.string()).meta({ description: "Names, A to Z." }),
    links: z.array(linkSchema),
    assignee: actorRefSchema.nullable(),
    assigneeId: id.nullable(),
    externalRef: z.string().nullable(),
    sourceAuthor,
    sourceStatus: z.string().nullable().meta({
      description:
        "On an imported item, its state's name in the system it came from (like In Review), kept for reference; status is what trail goes by.",
    }),
    createdBy: id,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp.nullable().meta({
      description:
        "When the item moved to done or canceled; null while it is in triage, open or in progress.",
    }),
  })
  .openapi("Item");

export const legacyIssueSchema = issueSchema
  .extend({ deprecated: deprecatedNote })
  .openapi("LegacyItem");

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
    product: z.string().nullable().meta({
      description: "The product's key, on a product's update; else null.",
    }),
    project: z.string().nullable().meta({
      description: "The project's slug, on a project's update; else null.",
    }),
    projectId: id.nullable().meta({
      description:
        "Deprecated: the product's id on a product's update, null on a project's.",
    }),
    authorId: id,
    body: z.string(),
    health: healthSchema,
    externalRef: z.string().nullable(),
    sourceAuthor,
    createdAt: timestamp,
  })
  .openapi("StatusUpdate");

export const labelSchema = z
  .object({
    id,
    projectId: id.meta({ description: "Deprecated: the product's id." }),
    name: z.string(),
    createdAt: timestamp,
  })
  .openapi("Label");

const countsSchema = z
  .object({
    triage: z.int(),
    open: z.int(),
    in_progress: z.int(),
    done: z.int(),
    canceled: z.int(),
  })
  .openapi("ItemCounts");

export const projectSchema = z
  .object({
    id,
    slug: z.string().meta({
      description: "How every tool and route names the project.",
      example: "launch-q4",
    }),
    name: z.string(),
    goal: z.string(),
    lead: actorRefSchema,
    targetDate: z.string().nullable().meta({
      description: "YYYY-MM-DD; null when unset.",
      example: "2026-12-01",
    }),
    products: z.array(productRefSchema).meta({
      description:
        "The products it draws items from that this key reaches, A to Z.",
    }),
    hiddenProducts: z.boolean().meta({
      description:
        "True when it also draws from products this key can't reach: their items are left out of counts and lists, and nothing names them.",
    }),
    counts: countsSchema.meta({
      description: "Its items per status, of the products listed only.",
    }),
    latestStatusUpdate: statusUpdateSchema
      .extend({ author: actorRefSchema })
      .nullable(),
    createdBy: id,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi("Project");

export const projectItemsAddedSchema = z
  .object({
    project: projectSchema,
    added: z
      .array(z.string())
      .meta({ description: "Keys of the items added." }),
    unchanged: z
      .array(z.string())
      .meta({ description: "Keys of the items that were in it already." }),
  })
  .openapi("ProjectItemsAdded");

export const projectItemsRemovedSchema = z
  .object({
    project: projectSchema,
    removed: z
      .array(z.string())
      .meta({ description: "Keys of the items taken out." }),
    unchanged: z
      .array(z.string())
      .meta({ description: "Keys of the items that were not in it." }),
  })
  .openapi("ProjectItemsRemoved");

export const activityEventSchema = z
  .object({
    id,
    actorId: id,
    subjectType: z.enum(activitySubjectTypes).meta({
      description:
        "product, project, issue (any item, todo or issue), comment, label or status_update; ignore one you don't know, as trail adds them over time.",
    }),
    subjectId: id,
    product: z.string().nullable().meta({
      description:
        "The key of the product the event is in; null on a project's own events (project.created, project.updated, a project's status update).",
    }),
    projectSlug: z.string().nullable().meta({
      description:
        "The slug of the project on a project's own event and on project.item_added and project.item_removed; else null.",
    }),
    projectId: id.nullable().meta({
      description: "Deprecated: the product's id, as in product.",
    }),
    action: z.string().meta({
      description:
        "Like issue.created, issue.updated, comment.created, product.created, product.updated, product.imported, project.created, project.updated, project.item_added, project.item_removed, status_update.created, label.created; ignore one you don't know.",
      example: "issue.updated",
    }),
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

const servedPhotoUrl = z.string().meta({
  description:
    "Where the photo is served, a path under /api/photos that changes whenever the photo does. It starts with /api, not /api/v1: resolve it against the API's origin and fetch it with a bot key or a signed-in session (operation GET /photos/{actorId}/{hash}, under the /api server). A 404 on an earlier URL means the photo changed or was removed: read photoUrl again.",
});

const photoUrl = z.string().nullable().meta({
  description:
    "Where the actor's photo is served, a path under /api/photos that changes whenever the photo does; null without one. It starts with /api, not /api/v1: resolve it against the API's origin and fetch it with a bot key or a signed-in session (operation GET /photos/{actorId}/{hash}, under the /api server). A 404 on an earlier URL means the photo changed or was removed: read photoUrl again.",
});

const titleAbout = `A bot's title: a short plain-text role, like "Release manager", that people see beside its name in trail; 1 to ${BOT_TITLE_MAX} characters once trimmed.`;

const actorTitle = z
  .string()
  .nullable()
  .meta({
    description: `${titleAbout} Null until the bot sets one, and always null on a person.`,
    example: "Release manager",
  });

export const actorSchema = z
  .object({
    id,
    kind: z.enum(actorKinds),
    name: actorName,
    label: actorLabel,
  })
  .openapi("Actor");

export const whoamiSchema = actorSchema
  .extend({
    scope: z
      .object({
        products: z
          .array(z.string())
          .nullable()
          .meta({
            description:
              "The keys of the only products this key reaches; null when it reaches every product.",
            example: ["TRL"],
          }),
        projects: z
          .array(z.string())
          .nullable()
          .meta({ description: "Deprecated alias of products." }),
        actions: z
          .array(z.enum(apiKeyActions))
          .nullable()
          .meta({
            description:
              "What this key may do: read, issues (add todos, file issues, update items, create and change projects), comments, status_updates and admin (create, update and import products, create labels, list bots). null when it may do all of them.",
            example: ["read", "issues", "comments"],
          }),
      })
      .meta({ description: "What the calling key reaches." }),
    ownProducts: z.array(productRefSchema).meta({
      description:
        "The products whose own bot you are, A to Z: add_todo goes to yours when you have exactly one.",
    }),
    products: z.array(productRefSchema).meta({
      description:
        "Every product this key reaches, A to Z: file issues on any of them.",
    }),
    photoUrl,
    title: actorTitle,
  })
  .openapi("Whoami");

export const botSchema = z
  .object({
    id,
    name: actorName,
    label: actorLabel,
    photoUrl,
    title: actorTitle,
  })
  .openapi("Bot");

export const myTitleUpdateSchema = z
  .strictObject({
    // trimmed before the length checks, which zod runs in order
    title: z
      .string()
      .trim()
      .min(1)
      .max(BOT_TITLE_MAX)
      .superRefine((title, ctx) => {
        const problem = botTitleCharacterProblem(title);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      })
      .meta({ description: titleAbout, example: "Release manager" }),
  })
  .openapi("MyTitleUpdate");

export const myTitleSchema = z
  .object({ title: z.string().meta({ description: "The title, trimmed." }) })
  .openapi("MyTitle");

export const myTitleRemovedSchema = z
  .object({
    title: z.null().meta({ description: "The bot has no title now." }),
  })
  .openapi("MyTitleRemoved");

export const myPhotoSchema = z
  .object({ photoUrl: servedPhotoUrl })
  .openapi("MyPhoto");

export const myPhotoRemovedSchema = z
  .object({
    photoUrl: z.null().meta({ description: "The bot has no photo now." }),
  })
  .openapi("MyPhotoRemoved");

/** Consecutive failed attempts, across a webhook's deliveries, that pause it. */
export const WEBHOOK_PAUSE_AFTER = 8;

export const webhookSchema = z
  .object({
    id,
    url: z.string(),
    products: z
      .array(z.string())
      .meta({ description: "The keys of the products it follows, A to Z." }),
    projects: z
      .array(z.string())
      .meta({ description: "Deprecated alias of products." }),
    paused: z.boolean().meta({
      description:
        "True after repeated failures; deliveries wait until an update or a rotate resumes it.",
    }),
    pausedAt: timestamp.nullable(),
    consecutiveFailures: z.int().meta({
      description: `Failed attempts since the last success; ${WEBHOOK_PAUSE_AFTER} pauses it.`,
    }),
    lastSuccessAt: timestamp.nullable(),
    lastError: z.string().nullable().meta({
      description: "What the last failed attempt got, like HTTP 500.",
    }),
    lastErrorAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .openapi("Webhook");

const webhookUrl = z.string().min(1).max(2048).meta({
  description:
    "An https URL that a public host serves, like https://bot.example.com/hooks/trail. Loopback, private and other internal addresses are refused.",
  example: "https://bot.example.com/hooks/trail",
});
const webhookSecret = z
  .string()
  .min(WEBHOOK_SECRET_MIN)
  .max(WEBHOOK_SECRET_MAX)
  .meta({
    description: `The signing secret of your OpenBot webhook routine, ${WEBHOOK_SECRET_MIN} to ${WEBHOOK_SECRET_MAX} characters. Read it from a key in a script; never send it through chat. Never returned.`,
  });
const webhookProducts = z
  .array(z.string().min(1))
  .min(1)
  .max(WEBHOOK_PRODUCTS_MAX)
  .meta({
    description:
      "Keys (like TRL) of the products to follow: you get their items' events, and the events of every project drawing from one of them. A product the key can't read is a 404, as a missing one is.",
    example: ["BGP"],
  });
const webhookProjectsAlias = z
  .array(z.string().min(1))
  .min(1)
  .max(WEBHOOK_PRODUCTS_MAX)
  .meta({
    description:
      "Deprecated alias of products: product keys. Send products instead; not both.",
  });

export const webhookCreateSchema = z
  .strictObject({
    url: webhookUrl,
    secret: webhookSecret,
    products: webhookProducts.optional(),
    projects: webhookProjectsAlias.optional(),
  })
  .openapi("WebhookCreate");

export const webhookUpdateSchema = z
  .strictObject({
    url: webhookUrl.optional(),
    products: webhookProducts.optional(),
    projects: webhookProjectsAlias.optional(),
  })
  .openapi("WebhookUpdate");

export const webhookSecretUpdateSchema = z
  .strictObject({ secret: webhookSecret })
  .openapi("WebhookSecretUpdate");

export const webhookTestResultSchema = z
  .object({
    delivered: z.boolean().meta({
      description: "True when the receiver answered 2xx.",
    }),
    status: z.int().nullable().meta({
      description: "The receiver's HTTP status; null when none came.",
    }),
    error: z.string().nullable(),
  })
  .openapi("WebhookTestResult");

export const webhookDeletedSchema = z
  .object({ deleted: z.literal(true) })
  .openapi("WebhookDeleted");

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
const productRef = id.meta({
  description:
    "The product's key (like TRL, any case) or id; list_products lists them.",
});
/** The legacy argument naming a product, from before projects. */
const projectRef = id.meta({
  description: "Deprecated: the product's key (like TRL) or id.",
});
const projectSlug = z.string().min(1).max(SLUG_MAX).meta({
  description:
    "The project's slug, like launch-q4, exactly; list_projects lists them.",
  example: "launch-q4",
});
const botRef = z.string().min(1).max(200);
const labelNames = z.array(labelName).max(ISSUE_LABELS_MAX).meta({
  description:
    "Label names. A name matches the product's label ignoring the case of A-Z; a new name creates the label.",
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
const productKey = z
  .string()
  .regex(
    /^[A-Za-z0-9]{2,10}$/,
    "must be 2 to 10 letters A-Z or digits, like TRL",
  );
const repoUrl = z.string().max(300).meta({
  description:
    "The product's GitHub repository, https://github.com/<owner>/<name>; a trailing slash or .git is dropped.",
  example: "https://github.com/acme/trail",
});
const ownerRef = botRef.meta({
  description:
    "The product's own bot, by name (any case) or id: what it adds are todos, and it accepts issues from triage.",
});

const productFields = {
  name,
  key: productKey.meta({
    description:
      "2 to 10 letters A-Z or digits, unique across products; lowercase is stored uppercased. Its items' keys are this, a dash and their number: TRL-12. Never changes.",
    example: "TRL",
  }),
  description: text.optional(),
  externalRef: externalRef.optional(),
};

export const productCreateSchema = z
  .strictObject({
    ...productFields,
    repoUrl: repoUrl.nullable().optional(),
    owner: ownerRef.nullable().optional().meta({
      description:
        "The product's own bot, by name (any case) or id; you by default, null for none. Its todos go to it, and it accepts issues from triage.",
    }),
  })
  .openapi("ProductCreate");

export const productUpdateSchema = z
  .strictObject({
    name: name.optional(),
    description: text.optional(),
    repoUrl: repoUrl
      .nullable()
      .optional()
      .meta({ description: "null clears it." }),
    owner: ownerRef.nullable().optional().meta({
      description:
        "The product's own bot, by name (any case) or id; null leaves the product without one.",
    }),
  })
  .openapi("ProductUpdate");

const goal = text.meta({
  description: "What the project is for, in a sentence or a few.",
});
const targetDate = z.string().max(10).meta({
  description: "A calendar day as YYYY-MM-DD.",
  example: "2026-12-01",
});
const leadRef = botRef.meta({
  description: "The bot leading the project, by name (any case) or id.",
});
const projectFields = {
  name,
  slug: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .meta({
      description: `How agents name the project: 2 to ${SLUG_MAX} lowercase letters, digits and hyphens, like launch-q4, unique. Left out, it is derived from the name (Launch Q4 → launch-q4), with -2, -3 ... added when taken.`,
    }),
  goal: goal.optional(),
  lead: leadRef.optional().meta({
    description:
      "The bot leading the project, by name (any case) or id; you by default.",
  }),
  targetDate: targetDate.nullable().optional(),
  products: z
    .array(z.string().min(1).max(10))
    .min(1)
    .max(50)
    .optional()
    .meta({
      description:
        "Keys (like TRL) of the products the project draws items from; the key must reach each. Left out: the one product you own. add_to_project adds an item's product by itself.",
      example: ["TRL", "KRU"],
    }),
};

/**
 * create_project and POST /projects: a project, or with `key` the deprecated
 * create of a product. Legacy fields are documented as such; the service
 * refuses a mix.
 */
export const projectCreateSchema = z
  .strictObject({
    ...projectFields,
    key: productKey.optional().meta({
      deprecated: true,
      description:
        "Deprecated: sending key creates a product, as this call did before projects; use create_product (POST /products) instead.",
    }),
    description: text.optional().meta({
      deprecated: true,
      description: "Deprecated, with key: the product's description.",
    }),
    externalRef: externalRef.optional().meta({
      deprecated: true,
      description: "Deprecated, with key: the product's externalRef.",
    }),
  })
  .openapi("ProjectCreate");

/** update_project and PATCH /projects/{ref}: a project's fields, or a product's name and description by the legacy meaning. */
export const projectUpdateSchema = z
  .strictObject({
    name: name.optional(),
    goal: goal.optional(),
    lead: leadRef.optional(),
    targetDate: targetDate.nullable().optional().meta({
      description: "A calendar day as YYYY-MM-DD; null clears it.",
    }),
    description: text.optional().meta({
      deprecated: true,
      description:
        "Deprecated: a product's description, when the project argument is a product key; use update_product instead.",
    }),
  })
  .openapi("ProjectUpdate");

export const projectItemsSchema = z
  .strictObject({
    items: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(100)
      .meta({
        description:
          "Item keys like TRL-12, at most 100; items of several products may go together.",
        example: ["TRL-12", "KRU-3"],
      }),
  })
  .openapi("ProjectItems");

const itemFields = {
  title,
  description: text.optional(),
  estimate: estimate.optional(),
  priority: priority.optional(),
  labels: labelNames.optional(),
  links: links.optional(),
  externalRef: externalRef.optional(),
};
const assigneeRef = botRef.meta({
  description:
    "Who works on it: a bot's name (any case) or id, or a person's id.",
});

export const todoCreateSchema = z
  .strictObject({
    product: productRef.optional().meta({
      description:
        "The product's key (like TRL); left out, the one product you own. list_products lists them.",
    }),
    ...itemFields,
    assignee: assigneeRef.optional().meta({
      description:
        "Who does it: a bot's name (any case) or id, or a person's id; left out, the product's owner, or you when it has none. A todo always has one.",
    }),
  })
  .openapi("TodoCreate");

export const issueFileSchema = z
  .strictObject({
    product: productRef.meta({
      description:
        "The key (like TRL) of the product the issue is for; any product this key reaches. list_products lists them.",
    }),
    ...itemFields,
    assignee: assigneeRef.nullable().optional().meta({
      description:
        "Usually left out: the product's bot assigns it when it accepts the issue from triage.",
    }),
  })
  .openapi("IssueFile");

/** POST /items: a todo or an issue by `type`. */
export const itemCreateSchema = z
  .strictObject({
    type: itemTypeSchema.meta({
      description:
        "todo: planned work for a product you own, open at once and assigned (to the product's owner by default). issue: a report to another product's bot, filed in triage until that bot accepts it (status open) or cancels it.",
    }),
    product: productRef.optional().meta({
      description:
        "The product's key (like TRL). Required for an issue; a todo goes to the one product you own when left out.",
    }),
    ...itemFields,
    assignee: assigneeRef.nullable().optional(),
  })
  .openapi("ItemCreate");

export const issueCreateSchema = z
  .strictObject({
    projectId: projectRef,
    ...itemFields,
    assigneeId: id.nullable().optional(),
  })
  .openapi("IssueCreate");

const itemPatchFields = {
  title: title.optional(),
  description: text.optional(),
  status: issueStatusSchema.optional().meta({
    description:
      "triage, open, in_progress, done or canceled. A product's bot accepts an issue from triage with open, or drops it with canceled. A todo is never in triage.",
  }),
  estimate: estimate
    .nullable()
    .optional()
    .meta({ description: "Hours; null clears." }),
  priority: priority.optional(),
  labels: labelNames.optional().meta({
    description: "Replaces the item's labels; [] removes them all.",
  }),
  links: links.optional().meta({
    description: "Replaces the item's links; [] removes them all.",
  }),
  addLabels: labelNames.optional().meta({
    description:
      "Labels to add, keeping the item's others, even those another bot added a moment ago. A name matches the product's label ignoring the case of A-Z; a new name creates the label. Not with labels.",
  }),
  removeLabels: z.array(labelName).max(50).optional().meta({
    description:
      "Labels to remove, by name ignoring the case of A-Z; a name the item lacks is ignored. Not with labels.",
  }),
  addLinks: links.optional().meta({
    description:
      "Links to add, keeping the item's others. A url already on the item takes the title sent here, or keeps its own when none is sent. Not with links.",
  }),
  removeLinks: z.array(z.string().min(1).max(2048)).max(50).optional().meta({
    description:
      "Urls of links to remove; a url the item lacks is ignored. Not with links.",
  }),
};

export const itemUpdateSchema = z
  .strictObject({
    type: itemTypeSchema.optional().meta({
      description:
        "todo makes it planned work of its product (an item in triage opens; it gets the product's owner as assignee when it has none); issue makes it a report.",
    }),
    ...itemPatchFields,
    assignee: assigneeRef.nullable().optional().meta({
      description:
        "A bot's name (any case) or id, or a person's id; null unassigns an issue (a todo always keeps one).",
    }),
  })
  .openapi("ItemUpdate");

export const issueUpdateSchema = z
  .strictObject({
    ...itemPatchFields,
    assigneeId: id
      .nullable()
      .optional()
      .meta({ description: "null unassigns." }),
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
    "The row's id in the system it came from: Linear's id, a UUID, not an identifier like JUS-187, which Linear changes when an issue moves team. A re-run matches rows by it: the product across trail, an issue within its product, a comment within its issue, a status update within its product.",
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
        "The issue's key in the system it came from (Linear's identifier, like JUS-187; a letter-or-digit prefix, a dash and a number). It is stored uppercased, and the issue is found by it wherever an id or key is taken, after them: an id or key that looks the same wins; a re-run sets it to the value sent. When its prefix is the product's key, a new issue keeps that number, so JUS-187 in Linear is JUS-187 in trail; if another issue already holds the number, the new one gets the product's next number and is listed in the result's renumbered, and is reached by the key listed there, since its sourceKey finds the issue holding that key. An imported issue's number never changes on a re-run. Unique across trail. Without it, an externalRef shaped like JUS-187 keeps its number instead.",
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
    key: productKey.meta({
      description:
        "The product's key, like TRL: 2 to 10 letters A-Z or digits. Fixed once imported; a re-run sends the same key.",
      example: "TRL",
    }),
    name,
    description: text.optional(),
    createdAt: sourceTimestamp.optional(),
    labels: z.array(labelName).max(1000).optional().meta({
      description:
        "Label names to create in the product beside those its issues name.",
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
    product: productSchema,
    project: productSchema.meta({
      description: "Deprecated alias of product.",
    }),
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
          "Items created without the number their sourceKey asked for, because another item in the product held it. Each is reached by its key here: its sourceKey is the key of the issue that held the number, so it finds that issue.",
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

export const itemListQuerySchema = pageQuerySchema.extend({
  product: productRef.optional(),
  project: projectSlug.optional().meta({
    description:
      "A project's slug, like launch-q4: only its items, of the products this key reaches.",
  }),
  type: itemTypeSchema.optional(),
  status: issueStatusSchema.optional(),
  assignee: assigneeRef.optional(),
});

export const activityListQuerySchema = pageQuerySchema.extend({
  cursor: z.string().optional().meta({
    description:
      "Pages newest first: pass the nextCursor of the previous page read without `after`. Bound to the filters (product or projectId, project, actorId) it was issued under.",
  }),
  after: z.string().optional().meta({
    description:
      "Resumes oldest first after this cursor; empty starts from the first event. The page's nextCursor is never null: pass it as `after` to poll for newer events. Bound to the filters (product or projectId, project, actorId) it was issued under.",
  }),
  product: productRef.optional(),
  project: projectSlug.optional().meta({
    description:
      "A project's slug: its own events (created, updated, status updates) and its items joining and leaving.",
  }),
  projectId: projectRef.optional(),
  actorId: id.optional(),
});

export type ApiError = z.infer<typeof errorSchema>;
export type ProductView = z.infer<typeof productSchema>;
export type ProjectView = z.infer<typeof projectSchema>;
export type IssueView = z.infer<typeof issueSchema>;
export type CommentView = z.infer<typeof commentSchema>;
export type StatusUpdateView = z.infer<typeof statusUpdateSchema>;
export type LabelView = z.infer<typeof labelSchema>;
export type ActorView = z.infer<typeof actorSchema>;
export type WhoamiView = z.infer<typeof whoamiSchema>;
export type WebhookView = z.infer<typeof webhookSchema>;
export type BotView = z.infer<typeof botSchema>;
export type MyPhotoView = z.infer<typeof myPhotoSchema>;
export type ActivityEventView = z.infer<typeof activityEventSchema>;
export type ImportResultView = z.infer<typeof importResultSchema>;
export type PageView<T> = { items: T[]; nextCursor: string | null };

// The human API under /api/web, which the SPA reads. Every row is shaped for display:
// actors come with their name and kind, projects and issues by key.

/**
 * The statuses the SPA draws. An item in triage is served as open until the web
 * API and SPA take triage (slice 3 of products and projects); see `webStatus`.
 */
export const webIssueStatuses = [
  "open",
  "in_progress",
  "done",
  "canceled",
] as const;
const webIssueStatusSchema = z.enum(webIssueStatuses).openapi("WebIssueStatus");

const webActorSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(actorKinds),
  photoUrl,
  title: actorTitle,
});
const webProjectRefSchema = z.object({ key: z.string(), name: z.string() });
const webIssueRefSchema = z.object({ key: z.string(), title: z.string() });

export const viewerStates = [
  "anonymous",
  "not_invited",
  "member",
  "owner",
] as const;

export const meSchema = z.object({
  state: z.enum(viewerStates),
  login: z.string().nullable().meta({
    description:
      "The lowercased GitHub login; null when anonymous or signed in by email.",
  }),
  email: z.string().nullable().meta({
    description:
      "The lowercased address of a person signed in by email, shown where a GitHub person's @login is; null otherwise.",
  }),
  actor: webActorSchema.nullable().meta({
    description: "Null until let in: anonymous or not_invited.",
  }),
  projects: z.array(webProjectRefSchema),
  ownerName: z.string().meta({
    description:
      "The owner actor's name, or TRAIL_OWNER_GITHUB before the owner has signed in.",
  }),
  emailSignIn: z.boolean().meta({
    description:
      "Whether this server can email a sign-in link; false until EMAIL_FROM, RESEND_API_KEY and BETTER_AUTH_URL are all set.",
  }),
});

const webStatusUpdateSchema = z.object({
  id,
  body: z.string(),
  health: healthSchema,
  author: webActorSchema,
  sourceAuthor,
  createdAt: timestamp,
});

export const webProjectSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  health: healthSchema.nullable().meta({
    description: "The latest status update's; null with none.",
  }),
  latestStatusUpdate: webStatusUpdateSchema.nullable(),
  openCount: z.int().meta({ description: "Issues with status open." }),
  inProgressCount: z
    .int()
    .meta({ description: "Issues with status in_progress." }),
  updatedAt: timestamp.meta({
    description:
      "The latest of the project's own edit, an issue's update and a status update.",
  }),
});

export const webProjectListSchema = z.object({
  items: z.array(webProjectSchema),
});

export const webIssueRowSchema = z.object({
  key: z.string(),
  title: z.string(),
  status: webIssueStatusSchema,
  priority: z.int(),
  labels: z.array(z.string()),
  assignee: webActorSchema.nullable(),
  updatedAt: timestamp,
});

export const webIssueListSchema = pageSchema(webIssueRowSchema).extend({
  counts: z
    .object({
      all: z.int(),
      open: z.int(),
      in_progress: z.int(),
      done: z.int(),
      canceled: z.int(),
    })
    .meta({
      description:
        "The project's issues per status and in all, whatever the status filter.",
    }),
});

export const webStatusUpdatePageSchema = pageSchema(webStatusUpdateSchema);

const entryBase = {
  id: z.string(),
  createdAt: timestamp,
  actor: webActorSchema,
  project: webProjectRefSchema,
};
const onIssue = { ...entryBase, issue: webIssueRefSchema };
const onProject = { ...entryBase, issue: z.null() };

export const entrySchema = z
  .discriminatedUnion("kind", [
    z.object({
      ...onIssue,
      kind: z.literal("issue_created"),
      sourceAuthor,
    }),
    z.object({
      ...onIssue,
      kind: z.literal("status_changed"),
      from: webIssueStatusSchema,
      to: webIssueStatusSchema,
    }),
    z.object({
      ...onIssue,
      kind: z.literal("priority_changed"),
      from: z.int(),
      to: z.int(),
    }),
    z.object({
      ...onIssue,
      kind: z.literal("labels_changed"),
      added: z.array(z.string()),
      removed: z.array(z.string()),
    }),
    z.object({ ...onIssue, kind: z.literal("link_added"), link: linkSchema }),
    z.object({
      ...onIssue,
      kind: z.literal("assignee_changed"),
      from: webActorSchema
        .nullable()
        .meta({ description: "Null: unassigned." }),
      to: webActorSchema.nullable().meta({ description: "Null: unassigned." }),
    }),
    z.object({
      ...onIssue,
      kind: z.literal("estimate_changed"),
      from: estimate.nullable(),
      to: estimate.nullable(),
    }),
    z.object({
      ...onIssue,
      kind: z.literal("comment"),
      comment: z.object({ id, body: z.string(), sourceAuthor }),
    }),
    z.object({
      ...onProject,
      kind: z.literal("status_update"),
      statusUpdate: z.object({
        id,
        body: z.string(),
        health: healthSchema,
        sourceAuthor,
      }),
    }),
    z.object({ ...onProject, kind: z.literal("project_created") }),
    z.object({
      ...onProject,
      kind: z.literal("project_imported"),
      imported: z.object({ issues: z.int(), comments: z.int() }).meta({
        description:
          "Issues and comments the import created or changed; an import that touched only the project, its labels or its status updates counts 0 of both.",
      }),
    }),
  ])
  .meta({
    description:
      "A feed row or issue timeline entry; switch on kind, and skip an entry whose kind you don't know: trail adds kinds over time.",
  });

export const webIssueSchema = z.object({
  key: z.string(),
  sourceKey: z.string().nullable(),
  project: webProjectRefSchema,
  title: z.string(),
  description: z.string(),
  status: webIssueStatusSchema,
  priority: z.int(),
  estimate: z.number().nullable(),
  labels: z.array(z.string()),
  links: z.array(linkSchema),
  assignee: webActorSchema.nullable(),
  creator: webActorSchema,
  sourceAuthor,
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp.nullable(),
  timeline: z.array(entrySchema).meta({
    description: "Oldest first: the filing, the comments and the changes.",
  }),
});

export const feedSchema = pageSchema(entrySchema).extend({
  filters: z
    .object({
      actors: z.array(webActorSchema),
      projects: z.array(webProjectRefSchema),
    })
    .meta({
      description:
        "What the feed can be filtered by: the bots that have acted in a visible project, and the visible projects.",
    }),
});

export const searchSchema = z.object({
  issues: z.array(
    z.object({
      key: z.string(),
      sourceKey: z.string().nullable(),
      title: z.string(),
      status: webIssueStatusSchema,
      project: webProjectRefSchema,
    }),
  ),
  projects: z.array(webProjectRefSchema),
});

export const personSchema = z.object({
  username: z.string().nullable().meta({
    description:
      "The lowercased GitHub username; null for a person invited by email. With `email`, the person's {username} in /people/{username}.",
  }),
  email: z.string().nullable().meta({
    description:
      "The lowercased email address of a person invited by email; null for a GitHub invite and the owner.",
  }),
  owner: z.boolean().meta({
    description: "The owner's row, which comes first and is not an invite.",
  }),
  pending: z.boolean().meta({
    description: "Invited, and the person hasn't signed in yet.",
  }),
  name: z.string().nullable().meta({
    description: "The person's display name once signed in.",
  }),
  photoUrl,
  projects: z.array(webProjectRefSchema),
  invitedAt: timestamp
    .nullable()
    .meta({ description: "Null on the owner's row." }),
});

export const peopleSchema = z.object({ items: z.array(personSchema) });

const projectKeys = z.array(z.string().min(1).max(10)).max(1000);

export { INVITEE_HINT, parseInvitee } from "./invitee.js";

export const personCreateSchema = z.strictObject({
  username: z.string().meta({
    description:
      "A GitHub username or an email address, told apart by the @; trimmed and lowercased.",
  }),
  projectKeys,
});

export const personUpdateSchema = z.strictObject({ projectKeys });

export const webIssueCreateSchema = z.strictObject({
  projectKey: z.string().min(1).max(10),
  // trimmed before the length checks, which zod runs in order
  title: z.string().trim().min(1).max(300),
  description: text.optional(),
});

export const webCommentCreateSchema = z.strictObject({
  // checked, not trimmed: a body's leading indentation can be Markdown
  body: text.refine((body) => body.trim() !== "", "must not be blank"),
});

export const webIssueListQuerySchema = pageQuerySchema.extend({
  status: webIssueStatusSchema.optional(),
});

const feedFilterQuery = {
  actor: id.optional().meta({ description: "An actor's id." }),
  project: z
    .string()
    .min(1)
    .optional()
    .meta({ description: "A project's key." }),
};

export const feedQuerySchema = pageQuerySchema.extend(feedFilterQuery);
export const eventsQuerySchema = z
  .object({
    ...feedFilterQuery,
    only: z.enum(["actors"]).optional().meta({
      description:
        "`actors`: only `actor` events and heartbeats, no feed entries; its own, larger per-person cap. Takes no other filter.",
    }),
  })
  .refine(
    (q) =>
      q.only === undefined ||
      (q.actor === undefined && q.project === undefined),
    { message: "only=actors takes no actor or project filter", path: ["only"] },
  );
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
});

export type ViewerState = (typeof viewerStates)[number];
export type MeView = z.infer<typeof meSchema>;
export type WebActorView = z.infer<typeof webActorSchema>;
export type WebProjectRefView = z.infer<typeof webProjectRefSchema>;
export type WebProjectView = z.infer<typeof webProjectSchema>;
export type WebProjectListView = z.infer<typeof webProjectListSchema>;
export type WebIssueRowView = z.infer<typeof webIssueRowSchema>;
export type WebIssueListView = z.infer<typeof webIssueListSchema>;
export type WebStatusUpdateView = z.infer<typeof webStatusUpdateSchema>;
export type WebStatusUpdatePageView = z.infer<typeof webStatusUpdatePageSchema>;
export type EntryView = z.infer<typeof entrySchema>;
export type EntryKind = EntryView["kind"];
export type WebIssueView = z.infer<typeof webIssueSchema>;
export type FeedView = z.infer<typeof feedSchema>;
export type SearchView = z.infer<typeof searchSchema>;
export type PersonView = z.infer<typeof personSchema>;
export type PeopleView = z.infer<typeof peopleSchema>;
export type PersonCreate = z.input<typeof personCreateSchema>;
export type PersonUpdate = z.input<typeof personUpdateSchema>;
export type WebIssueCreate = z.input<typeof webIssueCreateSchema>;
export type WebCommentCreate = z.input<typeof webCommentCreateSchema>;
