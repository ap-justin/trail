import { z } from "@hono/zod-openapi";
import {
  activitySubjectTypes,
  actorKinds,
  apiKeyActions,
  type IssueStatus,
  issueStatuses,
  issueTypes,
  productKinds,
  projectHealths,
  webhookSubscriptionKinds,
} from "../server/db/schema.js";
import {
  IMPORT_LINKS_MAX,
  IMPORT_TEXT_MAX,
  sourceStateTypes,
} from "../server/service/import.js";
import {
  MARK_READ_MAX,
  MESSAGE_PREVIEW_CHARS,
  MESSAGE_TEXT_MAX_BYTES,
} from "../server/service/messages.js";
import {
  BOT_TITLE_MAX,
  botTitleCharacterProblem,
  ISSUE_LABELS_MAX,
  ISSUE_LINKS_MAX,
  ITEM_NOTES_MAX,
  NOTE_ABOUT_MAX,
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
const productKindSchema = z
  .enum(productKinds)
  .meta({
    description:
      "product: a product with its own bot, who adds its todos and takes issues filed to it. team: a space a bot keeps for its own work when it owns no product, created with create_team (POST /teams); it holds todos, issues and notes like a product.",
  })
  .openapi("ProductKind");
// the statuses of an issue or a todo, which the routes from before notes take
const workStatusSchema = z
  .enum([
    "triage",
    "open",
    "in_progress",
    "done",
    "canceled",
  ] as const satisfies readonly IssueStatus[])
  .openapi("WorkStatus");
const WORK_TYPES =
  "todo: planned work of the product's own bot, open from the start and always assigned. issue: a request for work to the product's bot, filed in triage until that bot accepts it (status open with an assignee) or cancels it.";
const ITEM_TYPES = `${WORK_TYPES} note: a record nobody has to act on, current or archived and never assigned; about lists the items it is about.`;
const healthSchema = z.enum(projectHealths).openapi("ProjectHealth");
const priority = z.int().min(0).max(4).meta({
  description: "0 none, 1 urgent, 2 high, 3 medium, 4 low.",
});
const estimate = z.number().min(0).meta({ description: "Hours." });
const externalRef = z.string().min(1).max(200).meta({
  description:
    "The row's id in the system it came from, like ABC-167; unique within its scope, so a second create with it is a 409.",
  example: "ABC-167",
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
const itemLinkSchema = linkSchema
  .extend({
    pr: z
      .object({
        state: z.enum(["open", "draft", "merged", "closed"]),
        checkedAt: timestamp.meta({
          description: "When trail last read the state from GitHub.",
        }),
      })
      .nullable()
      .optional()
      .meta({
        description:
          "On a GitHub pull request link (https://github.com/<owner>/<repo>/pull/<n>): its state as trail last read it from GitHub, refreshed in the background once over 10 minutes old; null until the first read succeeds, which never happens on a private repo the server has no token for. Other links have no pr.",
      }),
  })
  .openapi("ItemLink");

export const errorSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ example: "not_found" }),
      message: z.string(),
    }),
  })
  .openapi("Error");

const noteCountsSchema = z
  .object({ current: z.int(), archived: z.int() })
  .openapi("NoteCounts");

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
    kind: productKindSchema,
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
    notes: noteCountsSchema.optional().meta({
      description:
        "On get_product (GET /products/{key}) only: its notes per status. No work count or progress includes notes: they are counted only here, in a project's `notes` and in an item's `notesCount`.",
    }),
  })
  .openapi("Product");

export const namedProductSchema = productSchema
  .pick({ id: true, key: true, name: true })
  .meta({
    description:
      "A product the key reaches only through a project drawing from it: its id, key and name. Through a project the key lists, its labels are read with list_labels (GET /products/{key}/labels); through a project drawing from the key's products, it shows its name and key only, and its labels are not found.",
  })
  .openapi("NamedProduct");

/** A product as a key reads it: whole when its products include it, named when it reaches it only through a project. */
export const productReadSchema = z
  .union([productSchema, namedProductSchema])
  .openapi("ProductRead");

export const legacyProductSchema = productSchema
  .extend({ deprecated: deprecatedNote })
  .openapi("LegacyProduct");

export const legacyNamedProductSchema = namedProductSchema
  .extend({ deprecated: deprecatedNote })
  .openapi("LegacyNamedProduct");

const productRefSchema = z
  .object({ key: z.string(), name: z.string() })
  .openapi("ProductRef");

const itemRefSchema = z
  .object({
    key: z.string().meta({ example: "TRL-12" }),
    title: z.string(),
    type: itemTypeSchema,
    status: issueStatusSchema,
  })
  .openapi("ItemRef");

export const issueSchema = z
  .object({
    id,
    key: z.string().meta({
      description: "The product's key and the item's number.",
      example: "TRL-12",
    }),
    number: z.int().meta({ example: 12 }),
    type: itemTypeSchema.meta({ description: ITEM_TYPES }),
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
        "On an imported item, its key in the system it came from, uppercased (like ABC-187). Any argument or path that takes the item's id or key takes this too.",
      example: "ABC-187",
    }),
    projectId: id.meta({ description: "Deprecated: the product's id." }),
    title: z.string(),
    description: z.string(),
    status: issueStatusSchema.meta({
      description:
        "An issue: triage, open, in_progress, done or canceled. A todo: the same but triage. A note: current or archived.",
    }),
    priority: priority.meta({
      description:
        "0 none, 1 urgent, 2 high, 3 medium, 4 low; always 0 on a note.",
    }),
    estimate: estimate.nullable().meta({
      description: "Hours; always null on a note.",
    }),
    labels: z.array(z.string()).meta({ description: "Names, A to Z." }),
    links: z.array(itemLinkSchema),
    assignee: actorRefSchema.nullable(),
    assigneeId: id.nullable(),
    filedFor: z
      .object({ name: z.string().meta({ example: "justin" }) })
      .nullable()
      .meta({
        description:
          "On an issue: the person it was filed for, by name. A bot's issue filed with filed_for \"handler\" is filed for its handler, and a person's own issue for that person. Null when filed for nobody, and on a todo or a note.",
      }),
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
        "When the item moved to done or canceled; null while it is in triage, open or in progress, and always on a note.",
    }),
    about: z.array(itemRefSchema).optional().meta({
      description:
        "On a note only: the items it is about that this key reaches, by key.",
    }),
    notes: z
      .array(itemRefSchema)
      .optional()
      .meta({
        description: `On get_item (GET /items/{key}) only: the ${ITEM_NOTES_MAX} newest current notes about this item that this key reaches, newest first. notesCount counts them all; list_items (GET /items) with about set to this item's key lists every one, archived ones too.`,
      }),
    notesCount: noteCountsSchema.optional().meta({
      description:
        "On get_item (GET /items/{key}) only: every note about this item that this key reaches, per status.",
    }),
    access: z.enum(["product", "project", "via_project"]).optional().meta({
      description:
        "On get_item (GET /items/{key}) for a bot: why this key reaches the item, the strongest grant first. product: its products cover the item's product (an unrestricted key too). project: a project the key lists holds the item, and the key works it as any non-owner bot. via_project: a project drawing from one of the key's products holds it, and the key may read it and comment on it (add_comment) and nothing else; any change is forbidden_scope until the key lists the item's product or project.",
      example: "product",
    }),
  })
  .openapi("Item");

const skippedLabels = z.array(z.string()).optional().meta({
  description:
    "When the labels came from a bot other than the owner of the item's product: the names sent that the product has no label for. Only the product's own labels are attached, and none is created; left out when every name matched.",
});

/** The answer to a create: the item, with skippedLabels when some were left off. */
export const createdItemSchema = issueSchema
  .extend({ skippedLabels })
  .openapi("CreatedItem");

/** The answer to an update: the item, with skippedLabels when some were left off. */
export const updatedItemSchema = issueSchema
  .extend({ skippedLabels })
  .openapi("UpdatedItem");

// the routes from before notes find no note, so a note's fields never reach them
export const legacyIssueSchema = issueSchema
  .omit({ about: true, notes: true, notesCount: true })
  .extend({
    type: z
      .enum(["issue", "todo"])
      .openapi("LegacyItemType")
      .meta({ description: WORK_TYPES }),
    status: z
      .enum(["open", "in_progress", "done", "canceled"])
      .openapi("LegacyIssueStatus")
      .meta({
        description:
          "The statuses items had before triage: an issue waiting in triage reads as open here; GET /items/{key} shows it as triage.",
      }),
    deprecated: deprecatedNote,
  })
  .openapi("LegacyItem");

export const legacyCreatedItemSchema = legacyIssueSchema
  .extend({ skippedLabels })
  .openapi("LegacyCreatedItem");

export const legacyUpdatedItemSchema = legacyIssueSchema
  .extend({ skippedLabels })
  .openapi("LegacyUpdatedItem");

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

/** The answer to add_comment: the comment, with hint when its body reads like a build log. */
export const createdCommentSchema = commentSchema
  .extend({
    hint: z.string().optional().meta({
      description:
        "Present when the body reads like a build log (commit SHAs, CI runs, agent run ids): what was found and where it belongs instead. The comment is saved either way.",
    }),
  })
  .openapi("CreatedComment");

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
        "The products it draws items from that this key reaches or can name, A to Z.",
    }),
    hiddenProducts: z.boolean().meta({
      description:
        "True when it also draws from products this key can't name: their items are left out of counts and lists, and nothing names them.",
    }),
    counts: countsSchema.meta({
      description:
        "Its issues and todos per status, of the products listed only; notes are in notes.",
    }),
    notes: noteCountsSchema.meta({
      description: "Its notes per status, of the products listed only.",
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

/** How a note's events carry about: list_activity, the webhook docs and the activity payload all say it. */
export const NOTE_EVENT_ABOUT =
  "A note's events name the items it is about by key. On its create event, about is an array of keys, like [\"TRL-3\"], of the items in the note's own product that the reading key reaches (on a webhook, the key its deliveries are checked against), in key order, and aboutOthers counts the rest: items in other products and items the key doesn't reach. An update that changes which of its own product's items it is about, or how many others, a turn into an issue or a todo included (which empties it), carries about {from, to} and aboutOthers {from, to} in the same form; an update that changes neither, or changes only items the reading key doesn't reach (a swap among other products' items, say), carries neither, and is no event at all when it changed nothing else. So about on an event is not the note's full list, and holds keys, not the {key, title, type, status} of an item's about: get_item (GET /items/{key}) on the note lists every item it is about that the key reaches, and that list can change with no event when the change is outside the key's reach.";

const eventAboutKeys = z.array(z.string());
const activityPayload = z
  .looseObject({
    about: z
      .union([
        eventAboutKeys,
        z.object({ from: eventAboutKeys, to: eventAboutKeys }),
      ])
      .optional()
      .meta({
        description:
          "On a note's events: keys on a create, {from, to} on an update.",
      }),
    aboutOthers: z
      .union([
        z.int().min(0),
        z.object({ from: z.int().min(0), to: z.int().min(0) }),
      ])
      .optional()
      .meta({
        description:
          "Beside about: how many items it leaves out, as a number or {from, to}.",
      }),
  })
  .meta({
    description: `What the event changed or created; its fields depend on action. ${NOTE_EVENT_ABOUT}`,
  });

export const activityEventSchema = z
  .object({
    id,
    actorId: id,
    subjectType: z.enum(activitySubjectTypes).meta({
      description:
        "product, project, issue (any item: a todo, an issue or a note), comment, label or status_update; ignore one you don't know, as trail adds them over time.",
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
      description: "Deprecated: the id of the product in product.",
    }),
    action: z.string().meta({
      description:
        "Like issue.created, issue.updated, comment.created, product.created, product.updated, product.imported, project.created, project.updated, project.item_added, project.item_removed, status_update.created, label.created; ignore one you don't know.",
      example: "issue.updated",
    }),
    payload: activityPayload,
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

const HANDLER =
  'The person the bot works for, whom file_issue files for with filed_for "handler".';

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
              "The keys of the products whose every item this key reaches; empty when it reaches only projects, null when it reaches everything.",
            example: ["TRL"],
          }),
        projects: z
          .array(z.string())
          .nullable()
          .meta({
            description:
              "The slugs of the projects whose items this key reaches, whichever product they are in; it can read those products' names, keys and labels, and nothing else of theirs. Empty when it has none, null when it reaches everything.",
            example: ["launch-q4"],
          }),
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
        "Every product this key files issues on, A to Z: those it reaches, and those its projects draw from, which it files on with project (file_issue, or POST /items with type issue).",
    }),
    impliedProjects: z.array(z.string()).meta({
      description:
        "The slugs of the projects drawing from one of this key's products that scope.projects doesn't list, A to Z. The key reads their items, whichever product they are in, and comments on them; changing an item of another product needs a key that lists that product or project. Their other products show their name and key only, never their labels. Empty for a key without a products list.",
      example: ["launch-q4"],
    }),
    photoUrl,
    title: actorTitle,
    unreadMessages: z.int().meta({
      description:
        "How many messages other bots sent you that you haven't marked read: list_inbox lists them.",
    }),
    team: productRefSchema.nullable().meta({
      description:
        "Your own team, whether or not this key reaches it; null when you have none, and the first by key if an admin gave you several.",
    }),
    hint: z.string().optional().meta({
      description:
        "Present only when you own no product and no team: where your own work, your records and your requests for work go, or which key to ask for when this one can't create a team.",
    }),
    handler: z
      .object({
        name: z.string().meta({ example: "justin" }),
        email: z.string().meta({ example: "justin@example.com" }),
      })
      .nullable()
      .meta({
        description: `${HANDLER} Only here does a bot read its handler's email; list_bots shows other bots' handlers by name alone. Null until the operator sets one with \`trail bot handler\`.`,
      }),
  })
  .openapi("Whoami");

export const botSchema = z
  .object({
    id,
    name: actorName,
    label: actorLabel,
    photoUrl,
    title: actorTitle,
    handler: z
      .object({ name: z.string().meta({ example: "justin" }) })
      .nullable()
      .meta({
        description: `${HANDLER} By name only, never the email. Null when the bot has none.`,
      }),
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

const webhookKind = z.enum(webhookSubscriptionKinds).meta({
  description:
    "activity: the events of the products and projects it follows. inbox: only trail.message.received, for each message another bot sends you; it follows no products or projects.",
});

export const webhookSchema = z
  .object({
    id,
    kind: webhookKind,
    url: z.string(),
    products: z.array(z.string()).meta({
      description:
        "The keys of the products it follows, A to Z; empty on an inbox webhook and on one following projects only.",
    }),
    projects: z.array(z.string()).meta({
      description:
        "The slugs of the projects it follows, A to Z; empty when it follows none.",
    }),
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
      description:
        'The last failure: what a failed attempt got, like HTTP 500, or why a delivery was not sent, with no attempt made, like "not sent: this webhook\'s key is revoked".',
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
const webhookProductsDescription =
  "Keys (like TRL) of the products to follow: you get their items' events, and the events of every project drawing from one of them. A product the key can't read is a 404, as a missing one is.";
const webhookProducts = z
  .array(z.string().min(1))
  .max(WEBHOOK_PRODUCTS_MAX)
  .meta({ description: webhookProductsDescription, example: ["ATL"] });
const webhookProjects = z
  .array(z.string().min(1).max(SLUG_MAX))
  .max(WEBHOOK_PRODUCTS_MAX)
  .meta({
    description:
      "Slugs (like launch-q4) of the projects to follow: you get the project's own events (updates, status updates, items joining and leaving) and the events of its items and their comments while they are in it, whichever product they are in. A product's key (like TRL) here is the deprecated alias of products and follows that product. A value that is neither, or a project the key neither lists nor reaches through its products (a key limited to products follows the projects drawing from them; an unrestricted key follows any), is a 404, as a missing project is.",
    example: ["launch-q4"],
  });

export const webhookCreateSchema = z
  .strictObject({
    kind: webhookKind.optional().meta({
      description:
        "activity (the default) for the events of products and projects; inbox for the messages other bots send you, with products and projects left out.",
    }),
    url: webhookUrl,
    secret: webhookSecret,
    products: webhookProducts.optional().meta({
      description: `Required unless kind is inbox or projects names a project; a key reaching exactly one project and no product follows that project when both are left out. ${webhookProductsDescription}`,
    }),
    projects: webhookProjects.optional(),
  })
  .openapi("WebhookCreate");

export const webhookUpdateSchema = z
  .strictObject({
    url: webhookUrl.optional(),
    products: webhookProducts.optional(),
    projects: webhookProjects.optional(),
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

const botRefSchema = z.object({ id, name: z.string() }).openapi("BotRef");
const messageText = z.string().meta({
  description: `Markdown, up to ${MESSAGE_TEXT_MAX_BYTES} bytes of UTF-8 (64 KiB).`,
});
const expectsReply = z.boolean().meta({
  description:
    "False when the sender asked for no reply (an FYI): a reply to it is refused.",
});
const replyToRef = id.nullable().meta({
  description:
    "The id of the message this one answers; null on a thread's first message.",
});
const threadRef = id.meta({
  description:
    "The thread: the id of its first message. get_thread (GET /messages/{id}/thread) reads it.",
});

export const messageSchema = z
  .object({
    id,
    from: botRefSchema,
    to: botRefSchema,
    threadId: threadRef,
    replyTo: replyToRef,
    expectsReply,
    text: messageText,
    createdAt: timestamp,
    readAt: timestamp.nullable().meta({
      description: "When the recipient marked it read; null while unread.",
    }),
  })
  .openapi("Message");

export const sentMessageSchema = z
  .object({
    message: messageSchema,
    thread: z
      .object({
        id: threadRef,
        messageCount: z
          .int()
          .meta({ description: "Messages in the thread, this one included." }),
      })
      .openapi("ThreadSummary"),
  })
  .openapi("SentMessage");

export const inboxEntrySchema = z
  .object({
    id,
    from: botRefSchema,
    threadId: threadRef,
    replyTo: replyToRef,
    expectsReply,
    preview: z.string().meta({
      description: `The text's first ${MESSAGE_PREVIEW_CHARS} characters; get_thread has the whole text.`,
    }),
    truncated: z.boolean().meta({
      description: "True when preview is shorter than the text.",
    }),
    createdAt: timestamp,
    readAt: timestamp.nullable(),
  })
  .openapi("InboxEntry");

export const messageCreateSchema = z
  .strictObject({
    to: z.string().min(1).optional().meta({
      description:
        "Required unless replyTo is set; the reply then goes to that message's other bot. The bot to message: its name in any case, or its id.",
      example: "beta",
    }),
    text: messageText,
    replyTo: id.optional().meta({
      description:
        "The id of a message in one of your conversations, to answer it in its thread. Leave it out to start a new thread.",
    }),
    expectsReply: z.boolean().optional().meta({
      description:
        "Default true. Send false for an FYI that needs no answer: the recipient then can't reply to it, which stops two bots thanking each other in a loop.",
    }),
  })
  .openapi("MessageCreate");

export const markReadSchema = z
  .strictObject({
    messageIds: z
      .array(id)
      .min(1)
      .max(MARK_READ_MAX)
      .meta({
        description: `1 to ${MARK_READ_MAX} ids of messages sent to you, from list_inbox.`,
      }),
  })
  .openapi("MarkRead");

export const markReadResultSchema = z
  .object({
    results: z.array(
      z.object({
        id,
        result: z.enum(["read", "already_read", "not_found"]).meta({
          description:
            "read: marked now. already_read: it was. not_found: no message with this id was sent to you (one you sent counts as not found).",
        }),
        readAt: timestamp.nullable(),
      }),
    ),
    unreadMessages: z.int().meta({
      description: "Your unread messages after this call.",
    }),
  })
  .openapi("MarkReadResult");

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
/** How the deprecated create and list name a product: projectId, or one of its aliases. */
const legacyProductFields = (required: boolean) => ({
  projectId: projectRef.optional().meta({
    description: `${required ? "Required, unless you send project or product. " : ""}The product's key (like TRL) or id.`,
  }),
  project: id.optional().meta({
    description: "Alias of projectId: send one of the three.",
  }),
  product: id.optional().meta({
    description: "Alias of projectId: send one of the three.",
  }),
});
const projectSlug = z.string().min(1).max(SLUG_MAX).meta({
  description:
    "The project's slug, like launch-q4, exactly; list_projects lists them.",
  example: "launch-q4",
});
const ONE_PROJECT_DEFAULT =
  "A key reaching a product only through projects sends `project` when it names more than one; with exactly one, that one is the default.";
const joiningProject = (joins: string) =>
  `A project's slug, like launch-q4: ${joins}, and product must be one the project draws from (left out, the project's one product). ${ONE_PROJECT_DEFAULT} list_projects lists them with their products.`;
const botRef = z.string().min(1).max(200);
const LABEL_NAMES =
  "A name matches the product's label ignoring the case of A-Z. Only the product's owner creates labels: from the owner, or on a product with no owner, a new name creates the label; from anyone else, the names the product lacks come back in skippedLabels.";
const labelNames = z
  .array(labelName)
  .max(ISSUE_LABELS_MAX)
  .meta({
    description: `Label names. ${LABEL_NAMES}`,
  });
const PULL_REQUEST_LINKS =
  "A pull request for the work goes here, and trail shows its state (open, draft, merged or closed) as the link's pr.";
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
      "2 to 10 letters A-Z or digits, unique across products and never a project's slug in any case (a 409); lowercase is stored uppercased. Its items' keys are this, a dash and their number: TRL-12. Never changes.",
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
    kind: productKindSchema.optional().meta({
      description:
        "product (the default) or team. A bot that owns nothing creates its own team with create_team (POST /teams), without the admin action.",
    }),
  })
  .openapi("ProductCreate");

export const teamCreateSchema = z
  .strictObject({
    name,
    key: productFields.key,
    description: text.optional(),
  })
  .openapi("TeamCreate");

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
        "The product's own bot, by name (any case) or id; null leaves the product without one. Only a product with no owner, or its owner, may change it; the operator reassigns one with `trail products set-owner`.",
    }),
    kind: productKindSchema.optional().meta({
      description:
        "product or team (a team is a space a bot keeps for its own work; create_team makes one); only this call changes it.",
    }),
  })
  .openapi("ProductUpdate");

const goal = text.meta({
  description: "What the project is for, in a sentence or a few.",
});
// the service's rule (service/validate.ts) refuses an impossible day too, like 2026-02-30
const targetDate = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "must be a calendar day as YYYY-MM-DD, like 2026-12-01",
  )
  .meta({
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
    .min(2)
    .max(SLUG_MAX)
    .optional()
    .meta({
      description: `How agents name the project: 2 to ${SLUG_MAX} lowercase letters, digits and hyphens, like launch-q4, unique, and never a product's key in any case (a 409). Left out, it is derived from the name (Launch Q4 gives launch-q4), with -2, -3 ... added when a project or a product's key holds it.`,
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
      example: ["TRL", "ATL"],
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
        example: ["TRL-12", "ATL-3"],
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
/**
 * The options of a strict object some of whose fields were renamed: an unknown
 * key that is a field's old name says what to send instead.
 */
const renamedFields = (advice: Record<string, string>) => ({
  error: (issue: { code?: string; keys?: string[] }) => {
    if (issue.code !== "unrecognized_keys" || issue.keys === undefined) {
      return undefined;
    }
    const old = issue.keys.filter((k) => k in advice);
    if (old.length === 0) return undefined;
    const unknown = issue.keys.filter((k) => !(k in advice));
    return [
      ...old.map((k) => `Unrecognized key "${k}": ${advice[k]}`),
      ...(unknown.length === 0
        ? []
        : [
            `Unrecognized key${unknown.length > 1 ? "s" : ""}: ${unknown.map((k) => `"${k}"`).join(", ")}`,
          ]),
    ].join("; ");
  },
});
const nowNamed = (field: string) =>
  `it is ${field} now, so send ${field} instead`;
const onLegacyRoute = (field: string, current: string) =>
  `on this deprecated route it is ${current}, so send ${current}, or use PATCH /items/{key} (update_item), which takes ${field}`;
const FILED_FOR_ARGUMENT =
  "the argument is filed_for, so send filed_for instead; filedFor is the field items answer with";
const itemCreateRenames = renamedFields({
  projectId: nowNamed("product"),
  assigneeId: nowNamed("assignee"),
  filedFor: FILED_FOR_ARGUMENT,
});

const filedFor = z.literal("handler").optional().meta({
  description:
    'Issues only. "handler" files the issue for the person you work for, your handler (whoami shows it), when you file on their behalf; they get one email when the issue ends. Leave it out for your own work. With no handler set it is a 422 naming the `trail bot handler` command the operator runs; on a todo or a note it is a 422.',
});

const assigneeRef = botRef.meta({
  description:
    "Who works on it: a bot's name (any case) or id, or a person's id.",
});

export const todoCreateSchema = z
  .strictObject(
    {
      product: productRef.optional().meta({
        description:
          "The product's key (like TRL); left out, the one product you own. list_products lists them.",
      }),
      ...itemFields,
      assignee: assigneeRef.optional().meta({
        description:
          "Who does it: a bot's name (any case) or id, or a person's id; left out, the product's owner, or you when it has none. A todo always has one.",
      }),
    },
    itemCreateRenames,
  )
  .openapi("TodoCreate");

/** Where file_issue and add_note file, as requireFilingGrant (service/index.ts) enforces it. */
const FILABLE_PRODUCTS =
  "a product this key lists (an unrestricted key, any product) or one a project it lists draws from. list_products also lists the products this key reads only through a project drawing from its own products, and those take nothing: that is forbidden_scope, naming the product to file on instead and the grant to ask for";

export const issueFileSchema = z
  .strictObject(
    {
      product: productRef.optional().meta({
        description: `The key (like TRL) of the product the issue is for: ${FILABLE_PRODUCTS}. Left out, the project's one product.`,
      }),
      project: projectSlug.optional().meta({
        description: joiningProject(
          "the issue joins that project as it is filed",
        ),
      }),
      ...itemFields,
      labels: labelNames.optional(),
      assignee: assigneeRef.nullable().optional().meta({
        description:
          "Usually left out: the product's bot assigns it when it accepts the issue from triage (status open with an assignee).",
      }),
      filed_for: filedFor,
    },
    itemCreateRenames,
  )
  // documents fileIssue's rule (service/index.ts), which enforces it with a 422 saying what to send
  .meta({
    description: "Name product, project, or both.",
    anyOf: [{ required: ["product"] }, { required: ["project"] }],
  })
  .openapi("IssueFile");

const aboutKeys = z
  .array(z.string().min(1).max(200))
  .max(NOTE_ABOUT_MAX)
  .meta({ example: ["TRL-12", "ATL-3"] });
const ABOUT = `Keys of the items the note is about, like TRL-12, in any product this key reaches, at most ${NOTE_ABOUT_MAX}; get_item on each lists the note in its notes.`;

export const noteCreateSchema = z
  .strictObject(
    {
      product: productRef.optional().meta({
        description: `The key (like TRL) of the product the note belongs to: ${FILABLE_PRODUCTS}. Left out, the project's one product.`,
      }),
      project: projectSlug.optional().meta({
        description: joiningProject(
          "the note joins that project as it is added",
        ),
      }),
      title,
      description: text.optional(),
      about: aboutKeys.optional().meta({ description: ABOUT }),
      labels: labelNames.optional(),
      links: links.optional(),
      externalRef: externalRef.optional(),
    },
    renamedFields({ projectId: nowNamed("product") }),
  )
  .meta({
    description: "Name product, project, or both.",
    anyOf: [{ required: ["product"] }, { required: ["project"] }],
  })
  .openapi("NoteCreate");

/** POST /items: a todo, an issue or a note by `type`. */
export const itemCreateSchema = z
  .strictObject(
    {
      type: itemTypeSchema.meta({
        description:
          "todo: planned work for a product you own (or one with no owner), open at once and assigned (to the product's owner by default); in another bot's product it is a 403. issue: a request for work to a product's bot, filed in triage until that bot accepts it (status open with an assignee) or cancels it. note: a record nobody has to act on, on any product you may file an issue on, current at once and never assigned.",
      }),
      product: productRef.optional().meta({
        description:
          "The product's key (like TRL). An issue or a note needs it unless project draws from one product; a todo goes to the one product you own when left out.",
      }),
      project: projectSlug.optional().meta({
        description: `Issues and notes only (a todo with it is a 422). ${joiningProject("the issue or note joins that project as it is added")}`,
      }),
      ...itemFields,
      estimate: estimate.nullable().optional().meta({
        description:
          "Hours; null or left out, none. A note takes no estimate: on a note, any value sent, null included, is a 422.",
      }),
      priority: priority.optional().meta({
        description:
          "0 none, 1 urgent, 2 high, 3 medium, 4 low. A note takes no priority: on a note, any value sent, 0 included, is a 422.",
      }),
      labels: labelNames.optional(),
      assignee: assigneeRef.nullable().optional().meta({
        description:
          "Who works on it: a bot's name (any case) or id, or a person's id. A note takes none.",
      }),
      about: aboutKeys.optional().meta({ description: `Notes only. ${ABOUT}` }),
      filed_for: filedFor,
    },
    itemCreateRenames,
  )
  .openapi("ItemCreate");

export const issueCreateSchema = z
  .strictObject(
    {
      ...legacyProductFields(true),
      ...itemFields,
      assigneeId: id.nullable().optional(),
      filed_for: filedFor,
    },
    renamedFields({
      assignee:
        "on this deprecated route it is assigneeId, so send assigneeId, or use POST /items (add_todo or file_issue), which takes assignee",
      filedFor: FILED_FOR_ARGUMENT,
    }),
  )
  // documents legacyProduct's rule (service/index.ts), which enforces it: a refine here would change the 422's message
  .meta({
    description:
      "Name the product with projectId, project or product: one of them is required. They are aliases, so more than one is a 422 unless they carry the same value.",
    anyOf: [
      { required: ["projectId"] },
      { required: ["project"] },
      { required: ["product"] },
    ],
  })
  .openapi("IssueCreate");

const itemPatchFields = {
  title: title.optional(),
  description: text.optional(),
  status: issueStatusSchema.optional().meta({
    description:
      "An issue or a todo: triage, open, in_progress, done or canceled. A product's bot accepts an issue from triage with open and an assignee (open alone leaves it unassigned), or drops it with canceled. A todo is never in triage. A note: current or archived.",
  }),
  estimate: estimate
    .nullable()
    .optional()
    .meta({ description: "Hours; null clears." }),
  priority: priority.optional(),
  labels: labelNames.optional().meta({
    description: `Replaces the item's labels; [] removes them all. ${LABEL_NAMES}`,
  }),
  links: links.optional().meta({
    description: `Replaces the item's links; [] removes them all. ${PULL_REQUEST_LINKS}`,
  }),
  addLabels: labelNames.optional().meta({
    description: `Labels to add, keeping the item's others, even those another bot added a moment ago. ${LABEL_NAMES} Not with labels.`,
  }),
  removeLabels: z.array(labelName).max(50).optional().meta({
    description:
      "Labels to remove, by name ignoring the case of A-Z; a name the item lacks is ignored. Not with labels.",
  }),
  addLinks: links.optional().meta({
    description: `Links to add, keeping the item's others. A url already on the item takes the title sent here, or keeps its own when none is sent. Not with links. ${PULL_REQUEST_LINKS}`,
  }),
  removeLinks: z.array(z.string().min(1).max(2048)).max(50).optional().meta({
    description:
      "Urls of links to remove; a url the item lacks is ignored. Not with links.",
  }),
};

export const itemUpdateSchema = z
  .strictObject(
    {
      type: itemTypeSchema.optional().meta({
        description:
          "todo makes it planned work of its product (an item in triage opens, and a note opens; it gets the product's owner as assignee when it has none); issue makes it a request for work (a note goes to triage); note makes it a record: status current, no assignee, priority 0 and estimate null. Only the product's owner changes an item's type; on a product with no owner any bot swaps todo and issue, and none turns an item into a note or a note into work.",
      }),
      ...itemPatchFields,
      estimate: itemPatchFields.estimate.meta({
        description:
          "Hours; null clears. A note holds none: on a note, or with type note, null is taken and any number is a 422.",
      }),
      priority: priority.optional().meta({
        description:
          "0 none, 1 urgent, 2 high, 3 medium, 4 low. A note holds none: on a note, or with type note, 0 is taken and any other value is a 422.",
      }),
      assignee: assigneeRef.nullable().optional().meta({
        description:
          "A bot's name (any case) or id, or a person's id; null unassigns an issue (a todo always keeps one, and a note never has one).",
      }),
      about: aboutKeys.optional().meta({
        description: `A note's: replaces the items it is about; [] clears them. A replace keeps the items this key cannot reach. ${ABOUT}`,
      }),
      addAbout: aboutKeys.optional().meta({
        description:
          "A note's: keys of items to add to those it is about, keeping the others. Not with about.",
      }),
      removeAbout: aboutKeys.optional().meta({
        description:
          "A note's: keys of items to drop from those it is about; a key it isn't about is ignored. Not with about.",
      }),
    },
    renamedFields({ assigneeId: nowNamed("assignee") }),
  )
  .openapi("ItemUpdate");

export const issueUpdateSchema = z
  .strictObject(
    {
      ...itemPatchFields,
      status: workStatusSchema.optional().meta({
        description:
          "triage, open, in_progress, done or canceled. A todo is never in triage.",
      }),
      assigneeId: id
        .nullable()
        .optional()
        .meta({ description: "null unassigns." }),
    },
    renamedFields({
      assignee: onLegacyRoute("assignee", "assigneeId"),
      type: "this deprecated route has no type: use PATCH /items/{key} (update_item) to change an item's type",
    }),
  )
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
    "The row's id in the system it came from: Linear's id, a UUID, not an identifier like ABC-187, which Linear changes when an issue moves team. A re-run matches rows by it: the product across trail, an issue within its product, a comment within its issue, a status update within its product.",
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
        "The issue's key in the system it came from (Linear's identifier, like ABC-187; a letter-or-digit prefix, a dash and a number). It is stored uppercased, and the issue is found by it wherever an id or key is taken, after them: an id or key that looks the same wins; a re-run sets it to the value sent. When its prefix is the product's key, a new issue keeps that number, so ABC-187 in Linear is ABC-187 in trail; if another issue already holds the number, the new one gets the product's next number and is listed in the result's renumbered, and is reached by the key listed there, since its sourceKey finds the issue holding that key. An imported issue's number never changes on a re-run. Unique across trail. Without it, an externalRef shaped like ABC-187 keeps its number instead.",
      example: "ABC-187",
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
    products: z.int(),
    projects: z.int().meta({ description: "Deprecated alias of products." }),
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

export const productListQuerySchema = pageQuerySchema.extend({
  kind: productKindSchema.optional().meta({
    description:
      "Only products, or only teams (a space a bot keeps for its own work), among those the key reads whole: a product it reaches only through a project is left out. Without kind, both kinds are listed, and so are those products.",
  }),
});

export const inboxQuerySchema = pageQuerySchema.extend({
  cursor: z.string().optional().meta({
    description:
      "The previous page's nextCursor; bound to the all it was issued under.",
  }),
  all: z.enum(["true", "false"]).optional().meta({
    description: "true lists read messages too; by default only unread ones.",
  }),
});

export const threadPageSchema = pageSchema(messageSchema)
  .extend({
    threadId: threadRef,
    bots: z.array(botRefSchema).meta({
      description:
        "The thread's two bots: the first message's sender, then its recipient.",
    }),
  })
  .openapi("Thread");

export const issueListQuerySchema = pageQuerySchema.extend({
  ...legacyProductFields(false),
  status: workStatusSchema.optional(),
  assigneeId: id.optional(),
});

export const itemListQuerySchema = pageQuerySchema.extend({
  product: productRef.optional(),
  project: projectSlug.optional().meta({
    description:
      "A project's slug, like launch-q4: only its items, of the products this key reaches.",
  }),
  type: itemTypeSchema.optional().meta({
    description:
      "todo, issue or note. Left out, issues and todos only: notes are listed only with type note or about.",
  }),
  status: issueStatusSchema.optional().meta({
    description:
      "triage, open, in_progress, done or canceled for issues and todos; current or archived with type note or about.",
  }),
  assignee: assigneeRef.optional(),
  about: z.string().min(1).max(200).optional().meta({
    description:
      "An item's key, like TRL-12: every note about it that this key reaches, archived ones too unless status says which. It lists notes, so type is note or left out.",
    example: "TRL-12",
  }),
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
export type NamedProductView = z.infer<typeof namedProductSchema>;
export type ProjectView = z.infer<typeof projectSchema>;
export type IssueView = z.infer<typeof issueSchema>;
export type CommentView = z.infer<typeof commentSchema>;
export type CreatedCommentView = z.infer<typeof createdCommentSchema>;
export type StatusUpdateView = z.infer<typeof statusUpdateSchema>;
export type LabelView = z.infer<typeof labelSchema>;
export type ActorView = z.infer<typeof actorSchema>;
export type WhoamiView = z.infer<typeof whoamiSchema>;
export type WebhookView = z.infer<typeof webhookSchema>;
export type MessageView = z.infer<typeof messageSchema>;
export type InboxEntryView = z.infer<typeof inboxEntrySchema>;
export type SentMessageView = z.infer<typeof sentMessageSchema>;
export type MarkReadResultView = z.infer<typeof markReadResultSchema>;
export type BotView = z.infer<typeof botSchema>;
export type MyPhotoView = z.infer<typeof myPhotoSchema>;
export type ActivityEventView = z.infer<typeof activityEventSchema>;
export type ImportResultView = z.infer<typeof importResultSchema>;
export type PageView<T> = { items: T[]; nextCursor: string | null };

// The human API under /api/web, which the SPA reads. Every row is shaped for display:
// actors come with their name and kind, products and items by key, projects by slug.

/**
 * An item's real status. The SPA draws triage as Open, so every count folds
 * triage into `open`, while rows carry the status as it is.
 */
export const webItemStatuses = issueStatuses;
const webItemStatusSchema = z.enum(issueStatuses).openapi("WebItemStatus");
const webItemTypeSchema = z.enum(issueTypes).openapi("WebItemType");

/** Bounds on the lists /api/web serves without paging. */
export const WEB_PRODUCT_PROJECTS_MAX = 100;
export const WEB_FEED_PROJECTS_MAX = 200;

const webActorSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(actorKinds),
  photoUrl,
  title: actorTitle,
});
const webProductRefSchema = z.object({
  key: z.string(),
  name: z.string(),
  kind: productKindSchema.optional().meta({
    description:
      "product or team; sent where the ref is built from the product's row (me's products), left out elsewhere.",
  }),
});
const webProjectRefSchema = z.object({ slug: z.string(), name: z.string() });
const webItemRefSchema = z.object({
  key: z.string(),
  title: z.string(),
  type: webItemTypeSchema,
});
const webItemLinkSchema = webItemRefSchema.extend({
  status: webItemStatusSchema,
});

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
  products: z.array(webProductRefSchema).meta({
    description:
      "The products the viewer sees, A to Z by key: every product for the person who runs this trail.",
  }),
  ownerName: z.string().meta({
    description:
      "The name of the person who runs this trail, or TRAIL_OWNER_GITHUB before they have signed in.",
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

const webStatusCountsSchema = z
  .object({
    all: z.int(),
    open: z.int().meta({ description: "Open and triage together." }),
    in_progress: z.int(),
    done: z.int(),
    canceled: z.int(),
  })
  .meta({ description: "Items per status tab and in all." });

const webItemCountsSchema = z
  .object({
    all: webStatusCountsSchema,
    issue: webStatusCountsSchema,
    todo: webStatusCountsSchema,
    notes: z
      .object({ current: z.int(), archived: z.int() })
      .meta({ description: "Notes per status; all leaves them out." }),
  })
  .meta({
    description:
      "Per type (all, issue, todo) and status tab, whatever the type and status filters: the tabs follow the type toggle by reading the toggled type's counts. Notes are counted apart, in notes.",
  });

export const webProductSchema = z.object({
  key: z.string(),
  name: z.string(),
  kind: productKindSchema,
  description: z.string(),
  repoUrl: z.string().nullable().meta({
    description: "https://github.com/owner/name; null with none.",
  }),
  health: healthSchema.nullable().meta({
    description: "The latest status update's; null with none.",
  }),
  latestStatusUpdate: webStatusUpdateSchema.nullable(),
  openIssues: z.int().meta({
    description: "Issues in triage or open, as the Open tab counts them.",
  }),
  openTodos: z.int().meta({ description: "Todos with status open." }),
  projectCount: z.int().meta({
    description: "Projects drawing from the product.",
  }),
  updatedAt: timestamp.meta({
    description:
      "The latest of the product's own edit, an item's update and a status update.",
  }),
});

export const webProductListSchema = z.object({
  items: z.array(webProductSchema),
});

export const webProjectSchema = z.object({
  slug: z.string(),
  name: z.string(),
  goal: z.string(),
  health: healthSchema.nullable().meta({
    description: "The latest status update's; null with none.",
  }),
  latestStatusUpdate: webStatusUpdateSchema.nullable(),
  lead: webActorSchema,
  targetDate: z.string().nullable().meta({
    description: "YYYY-MM-DD; null with none.",
  }),
  products: z.array(webProductRefSchema).meta({
    description:
      "The project's products the viewer sees, A to Z by key; never one they can't.",
  }),
  openCount: z.int().meta({
    description:
      "Items in triage or open, of the products the viewer sees, as the Open tab counts them.",
  }),
  updatedAt: timestamp.meta({
    description:
      "The latest of the project's own edit, an item added or removed, and a status update.",
  }),
});

export const webProjectPageSchema = pageSchema(webProjectSchema);

export const webProjectDetailSchema = webProjectSchema.extend({
  hiddenProducts: z.boolean().meta({
    description:
      "Whether the project draws from a product the viewer can't see; nothing else about such a product is served.",
  }),
});

export const webProductDetailSchema = webProductSchema.extend({
  owner: webActorSchema.nullable().meta({
    description: "The bot that plans the product's todos; null with none.",
  }),
  projects: z.array(webProjectSchema).meta({
    description: `The projects drawing from the product, newest first, at most ${WEB_PRODUCT_PROJECTS_MAX}; projectCount has them all.`,
  }),
});

const webFiledForSchema = z.object({ name: z.string() }).nullable().meta({
  description:
    "The person an issue was filed for, by name: a bot's handler, or the person who filed it in the web app. Null when filed for nobody, and on a todo or a note.",
});

export const webItemRowSchema = z.object({
  key: z.string(),
  type: webItemTypeSchema,
  title: z.string(),
  status: webItemStatusSchema,
  priority: z.int(),
  labels: z.array(z.string()),
  assignee: webActorSchema
    .nullable()
    .meta({ description: "Null: unassigned, which a todo never is." }),
  filedFor: webFiledForSchema,
  updatedAt: timestamp,
});

export const webItemListSchema = pageSchema(webItemRowSchema).extend({
  counts: webItemCountsSchema,
});

export const webProjectItemsSchema = z.object({
  groups: z
    .array(
      z.object({
        product: webProductRefSchema,
        count: z.int().meta({
          description:
            "The group's items under the type and status filters, on every page.",
        }),
        items: z.array(webItemRowSchema),
      }),
    )
    .meta({
      description:
        "This page's rows per product, A to Z by key, newest first within one; a product with no row on the page has no group. The next page continues the last group.",
    }),
  nextCursor: z.string().nullable(),
  counts: webItemCountsSchema.meta({
    description:
      "Per type and status tab over the project's items the viewer sees, under the product filter alone.",
  }),
});

export const webStatusUpdatePageSchema = pageSchema(webStatusUpdateSchema);

const entryBase = {
  id: z.string(),
  createdAt: timestamp,
  actor: webActorSchema,
};
const onItem = {
  ...entryBase,
  product: webProductRefSchema,
  project: z.null(),
  item: webItemRefSchema,
};
const onProduct = {
  ...entryBase,
  product: webProductRefSchema,
  project: z.null(),
  item: z.null(),
};
const onProject = {
  ...entryBase,
  product: z.null(),
  project: webProjectRefSchema,
  item: z.null(),
};
const onMembership = {
  ...entryBase,
  product: webProductRefSchema,
  project: webProjectRefSchema,
  item: webItemRefSchema,
};
const statusUpdateBody = z.object({
  id,
  body: z.string(),
  health: healthSchema,
  sourceAuthor,
});

export const webProjectFields = ["name", "goal", "lead", "targetDate"] as const;

export const entrySchema = z
  .discriminatedUnion("kind", [
    z.object({
      ...onItem,
      kind: z.literal("item_created"),
      sourceAuthor,
      createdAs: webItemTypeSchema.meta({
        description:
          "The type the item was created with, which item.type no longer shows once the owner retypes it: issue when it was filed, todo when it was planned. An item created before trail recorded this reads issue when a person created it, else its current type.",
      }),
    }),
    z.object({
      ...onItem,
      kind: z.literal("status_changed"),
      from: webItemStatusSchema,
      to: webItemStatusSchema,
    }),
    z.object({
      ...onItem,
      kind: z.literal("type_changed"),
      from: webItemTypeSchema,
      to: webItemTypeSchema,
    }),
    z.object({
      ...onItem,
      kind: z.literal("priority_changed"),
      from: z.int(),
      to: z.int(),
    }),
    z.object({
      ...onItem,
      kind: z.literal("labels_changed"),
      added: z.array(z.string()),
      removed: z.array(z.string()),
    }),
    z.object({ ...onItem, kind: z.literal("link_added"), link: linkSchema }),
    z
      .object({
        ...onItem,
        kind: z.literal("about_changed"),
        added: z.array(z.string()).meta({
          description:
            "Keys of the items in the note's product the edit made it about, in key order.",
        }),
        removed: z.array(z.string()).meta({
          description:
            "Keys of the items in the note's product it is no longer about, in key order.",
        }),
        others: z.object({ from: z.int(), to: z.int() }).meta({
          description:
            "How many items it was and is about in products the entry doesn't name, before and after the edit; equal when only named items changed.",
        }),
      })
      .meta({
        description:
          "On an item's timeline only, never in the feed: a note's edit changed the items it is about.",
      }),
    z.object({
      ...onItem,
      kind: z.literal("assignee_changed"),
      from: webActorSchema
        .nullable()
        .meta({ description: "Null: unassigned." }),
      to: webActorSchema.nullable().meta({ description: "Null: unassigned." }),
    }),
    z.object({
      ...onItem,
      kind: z.literal("estimate_changed"),
      from: estimate.nullable(),
      to: estimate.nullable(),
    }),
    z.object({
      ...onItem,
      kind: z.literal("comment"),
      comment: z.object({ id, body: z.string(), sourceAuthor }),
    }),
    z.object({ ...onMembership, kind: z.literal("added_to_project") }),
    z.object({ ...onMembership, kind: z.literal("removed_from_project") }),
    z.object({
      ...onProduct,
      kind: z.literal("product_status_update"),
      statusUpdate: statusUpdateBody,
    }),
    z.object({ ...onProduct, kind: z.literal("product_created") }),
    z.object({ ...onProduct, kind: z.literal("team_created") }),
    z.object({
      ...onProduct,
      kind: z.literal("product_imported"),
      imported: z.object({ issues: z.int(), comments: z.int() }).meta({
        description:
          "Items and comments the import created or changed; an import that touched only the product, its labels or its status updates counts 0 of both.",
      }),
    }),
    z.object({
      ...onProject,
      kind: z.literal("project_status_update"),
      statusUpdate: statusUpdateBody,
    }),
    z.object({ ...onProject, kind: z.literal("project_created") }),
    z.object({
      ...onProject,
      kind: z.literal("project_updated"),
      changed: z.array(z.enum(webProjectFields)).meta({
        description: "The fields the edit changed, in this enum's order.",
      }),
    }),
  ])
  .meta({
    description:
      "A feed row or item timeline entry; switch on kind, and skip an entry whose kind you don't know: trail adds kinds over time. `product` is null on a project's own entries (no product key shows), `project` set on those and on added/removed.",
  });

export const webItemSchema = z.object({
  key: z.string(),
  type: webItemTypeSchema,
  sourceKey: z.string().nullable(),
  product: webProductRefSchema,
  projects: z.array(webProjectRefSchema).meta({
    description:
      "The projects the item is in, by slug; each draws from the item's product, so the viewer sees it.",
  }),
  title: z.string(),
  description: z.string(),
  status: webItemStatusSchema,
  priority: z.int(),
  estimate: z.number().nullable(),
  labels: z.array(z.string()),
  links: z.array(itemLinkSchema),
  assignee: webActorSchema
    .nullable()
    .meta({ description: "Null: unassigned, which a todo never is." }),
  creator: webActorSchema.meta({
    description:
      "Who filed the issue, or planned the todo: the byline reads `filed by` or `planned by` after `type`.",
  }),
  filedFor: webFiledForSchema,
  sourceAuthor,
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp.nullable(),
  about: z.array(webItemLinkSchema).meta({
    description:
      "On a note: the items it is about that the viewer sees, by key; empty on an issue or a todo.",
  }),
  notes: z.array(webItemLinkSchema).meta({
    description: `The ${ITEM_NOTES_MAX} newest current notes about the item that the viewer sees, newest first.`,
  }),
  notesCount: noteCountsSchema.meta({
    description: "Every note about the item that the viewer sees, per status.",
  }),
  timeline: z.array(entrySchema).meta({
    description:
      "Oldest first: the filing, the comments, the changes and the project adds and removes.",
  }),
});

export const feedSchema = pageSchema(entrySchema).extend({
  filters: z
    .object({
      actors: z.array(webActorSchema),
      products: z.array(webProductRefSchema),
      projects: z.array(webProjectRefSchema).meta({
        description: `The projects the viewer sees, A to Z by name, at most ${WEB_FEED_PROJECTS_MAX}.`,
      }),
    })
    .meta({
      description:
        "What the feed can be filtered by: the bots that have acted in a visible product, the visible products and the visible projects.",
    }),
});

export const searchSchema = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      sourceKey: z.string().nullable(),
      title: z.string(),
      type: webItemTypeSchema,
      status: webItemStatusSchema,
      product: webProductRefSchema,
    }),
  ),
  products: z.array(webProductRefSchema),
  projects: z.array(webProjectRefSchema),
});

export const workingNowSchema = z.object({
  total: z.int().meta({
    description:
      "Every in-progress item assigned to a bot in a visible product, however many `entries` has.",
  }),
  entries: z.array(
    z.object({
      item: webItemRefSchema.pick({ key: true, title: true }),
      productKey: z.string(),
      bot: webActorSchema.meta({ description: "The item's assignee." }),
    }),
  ),
});

export const personSchema = z.object({
  username: z.string().nullable().meta({
    description:
      "The lowercased GitHub username; null for a person invited by email. With `email`, the person's {username} in /people/{username}.",
  }),
  email: z.string().nullable().meta({
    description:
      "The lowercased email address of a person invited by email; null for a GitHub invite and for the person who runs this trail.",
  }),
  owner: z.boolean().meta({
    description:
      "The row of the person who runs this trail, which comes first, is not an invite, and sees all products.",
  }),
  pending: z.boolean().meta({
    description: "Invited, and the person hasn't signed in yet.",
  }),
  name: z.string().nullable().meta({
    description: "The person's display name once signed in.",
  }),
  photoUrl,
  products: z.array(webProductRefSchema).meta({
    description: "The products the person sees, A to Z by key.",
  }),
  invitedAt: timestamp.nullable().meta({
    description: "Null on the row of the person who runs this trail.",
  }),
});

export const peopleSchema = z.object({ items: z.array(personSchema) });

const webMessagePreview = {
  preview: z.string().meta({
    description: `The text's first ${MESSAGE_PREVIEW_CHARS} characters.`,
  }),
  truncated: z.boolean().meta({
    description: "True when preview is shorter than the text.",
  }),
};

const webBotPair = z.tuple([webActorSchema, webActorSchema]).meta({
  description: "The pair's two bots, in id order.",
});

export const webConversationSchema = z.object({
  bots: webBotPair,
  lastMessage: z.object({
    id,
    senderId: id,
    ...webMessagePreview,
    createdAt: timestamp,
    expectsReply: z.boolean(),
  }),
  count: z.int().meta({ description: "Messages between the two bots." }),
  lastAt: timestamp.meta({ description: "When the last message was sent." }),
});

export const webConversationPageSchema = pageSchema(webConversationSchema);

export const webMessageSchema = z.object({
  id,
  sender: webActorSchema,
  recipient: webActorSchema,
  threadId: id.meta({ description: "The id of the thread's first message." }),
  replyTo: z
    .object({ id, senderName: z.string(), ...webMessagePreview })
    .nullable()
    .meta({
      description:
        "The message this one answers, as a quote; null on a thread's first message.",
    }),
  text: z.string().meta({ description: "Markdown." }),
  expectsReply: z.boolean().meta({
    description: "False when the sender asked for no reply.",
  }),
  createdAt: timestamp,
  readAt: timestamp.nullable().meta({
    description: "When the recipient marked it read; null while unread.",
  }),
});

export const webMessagePageSchema = pageSchema(webMessageSchema).extend({
  bots: webBotPair,
});

const productKeys = z
  .array(z.string().min(1).max(10))
  .max(1000)
  .meta({ description: "Product keys, in any case." });

export { INVITEE_HINT, parseInvitee } from "./invitee.js";

export const personCreateSchema = z.strictObject({
  username: z.string().meta({
    description:
      "A GitHub username or an email address, told apart by the @; trimmed and lowercased.",
  }),
  products: productKeys,
});

export const personUpdateSchema = z.strictObject({ products: productKeys });

export const webIssueCreateSchema = z.strictObject({
  product: z.string().min(1).max(10).meta({
    description:
      "The key of a product the person sees. The issue starts in triage.",
  }),
  // trimmed before the length checks, which zod runs in order
  title: z.string().trim().min(1).max(300),
  description: text.optional(),
});

export const webCommentCreateSchema = z.strictObject({
  // checked, not trimmed: a body's leading indentation can be Markdown
  body: text.refine((body) => body.trim() !== "", "must not be blank"),
});

const itemFilters = {
  type: webItemTypeSchema.optional().meta({
    description: "Left out, issues and todos: notes are listed with type note.",
  }),
  status: webItemStatusSchema.optional().meta({
    description: "open matches triage too, as the Open tab counts it.",
  }),
};

export const webItemListQuerySchema = pageQuerySchema.extend(itemFilters);

export const webProjectItemsQuerySchema = pageQuerySchema.extend({
  ...itemFilters,
  product: z.string().min(1).max(10).optional().meta({
    description: "A product key: only that product's group.",
  }),
});

const feedFilterQuery = {
  actor: id.optional().meta({ description: "An actor's id." }),
  product: z
    .string()
    .min(1)
    .max(10)
    .optional()
    .meta({ description: "A product's key." }),
  project: projectSlug.optional().meta({
    description:
      "A project's slug: its own events and its items being added or removed.",
  }),
  type: itemTypeSchema.optional().meta({
    description:
      "issue, todo or note: only the entries of items of that type now (created, changed, commented on, added to or taken out of a project), and no product's or project's own entry.",
  }),
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
      (q.actor === undefined &&
        q.product === undefined &&
        q.project === undefined &&
        q.type === undefined),
    {
      message: "only=actors takes no actor, product, project or type filter",
      path: ["only"],
    },
  );
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
});

export type ViewerState = (typeof viewerStates)[number];
export type MeView = z.infer<typeof meSchema>;
export type WebActorView = z.infer<typeof webActorSchema>;
export type WebItemStatus = z.infer<typeof webItemStatusSchema>;
export type WebItemType = z.infer<typeof webItemTypeSchema>;
export type WebProductRefView = z.infer<typeof webProductRefSchema>;
export type WebProjectRefView = z.infer<typeof webProjectRefSchema>;
export type WebItemRefView = z.infer<typeof webItemRefSchema>;
export type WebStatusCountsView = z.infer<typeof webStatusCountsSchema>;
export type WebItemCountsView = z.infer<typeof webItemCountsSchema>;
export type WebProductView = z.infer<typeof webProductSchema>;
export type WebProductListView = z.infer<typeof webProductListSchema>;
export type WebProductDetailView = z.infer<typeof webProductDetailSchema>;
export type WebProjectView = z.infer<typeof webProjectSchema>;
export type WebProjectPageView = z.infer<typeof webProjectPageSchema>;
export type WebProjectDetailView = z.infer<typeof webProjectDetailSchema>;
export type WebProjectItemsView = z.infer<typeof webProjectItemsSchema>;
export type WebItemRowView = z.infer<typeof webItemRowSchema>;
export type WebWorkingNowView = z.infer<typeof workingNowSchema>;
export type WebItemListView = z.infer<typeof webItemListSchema>;
export type WebStatusUpdateView = z.infer<typeof webStatusUpdateSchema>;
export type WebStatusUpdatePageView = z.infer<typeof webStatusUpdatePageSchema>;
export type EntryView = z.infer<typeof entrySchema>;
export type EntryKind = EntryView["kind"];
export type WebItemView = z.infer<typeof webItemSchema>;
export type FeedView = z.infer<typeof feedSchema>;
export type SearchView = z.infer<typeof searchSchema>;
export type PersonView = z.infer<typeof personSchema>;
export type PeopleView = z.infer<typeof peopleSchema>;
export type WebConversationView = z.infer<typeof webConversationSchema>;
export type WebConversationPageView = z.infer<typeof webConversationPageSchema>;
export type WebMessageView = z.infer<typeof webMessageSchema>;
export type WebMessagePageView = z.infer<typeof webMessagePageSchema>;
export type PersonCreate = z.input<typeof personCreateSchema>;
export type PersonUpdate = z.input<typeof personUpdateSchema>;
export type WebIssueCreate = z.input<typeof webIssueCreateSchema>;
export type WebCommentCreate = z.input<typeof webCommentCreateSchema>;
