import { createRoute } from "@hono/zod-openapi";
import {
  commentCreateSchema,
  commentSchema,
  createdCommentSchema,
  createdItemSchema,
  issueSchema,
  itemCreateSchema,
  itemListQuerySchema,
  itemUpdateSchema,
  pageQuerySchema,
  pageSchema,
  updatedItemSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
import { ITEM_NOTES_MAX } from "../service/validate.js";
import { createRouter } from "./env.js";
import {
  conflictError,
  forbiddenError,
  idempotencyHeaders,
  itemParam,
  jsonBody,
  jsonContent,
  notFoundError,
  OWNER_ONLY,
  readErrors,
  VIA_PROJECT,
  VIA_PROJECT_FILING,
  writeErrors,
} from "./routes.js";
import {
  toComment,
  toCreatedComment,
  toIssue,
  toPage,
  withSkippedLabels,
} from "./serialize.js";

const tags = ["items"];

export const TODO_OR_ISSUE =
  "A todo is planned work of a product's own bot (its owner), and only that bot adds one: open from the start and always assigned (to the owner unless it names someone). An issue is a report to a product's bot, from a person or any other bot: it starts in triage until that bot accepts it (status open with assignee, the bot that will work on it) or cancels it; its filer may cancel it too. A product with no owner leaves both to any bot that reaches it.";

/** When to add which item: every create says it. */
export const WHICH_ITEM =
  "Pick the item by who has to act: a todo is planned work you do in a product or team you own (add_todo); an issue asks a product's bot for work (file_issue); a note is a record nobody has to act on, like how something works or why a decision was made (add_note). Anything in a note that someone has to act on goes in its own issue (file_issue), with the note's key, like TRL-12, in the issue's description (links take web URLs only); a note you can edit lists that issue in its about.";

/** Who edits a note, and how its fields differ from work's: update_item and PATCH /items/{key} both say it. */
export const NOTE_EDITS =
  "A note is edited only by its author and its product's own bot, and on a product with no owner only by its author; anyone else is refused (forbidden) and comments with add_comment. Its status is current or archived, it has no assignee, priority or estimate (priority reads 0 and estimate null, and an update takes those two values and refuses any other), and about, addAbout and removeAbout set the items it is about. Only the product's owner turns an item into a note (type note: status current, assignee dropped, priority and estimate cleared) or a note back into work (an issue goes to triage, a todo opens assigned to the owner), so on a product with no owner no bot does either.";

/** What ending an issue filed for a person sends: update_item and PATCH /items/{key} both say it. */
export const ENDING_EMAIL =
  "Done or canceled on an item with a filedFor person emails them if trail has their address (let in by email, or the verified GitHub primary address trail first read at sign-in) and they can see its product, again on each later ending after a reopen, unless they have unsubscribed from these emails. The email quotes your latest comment on the item, else the product's own bot's: comment the result or the reason first.";

export const COMMENT_HOLDS =
  "A comment holds what changed for the work and why, a decision or scope change, a blocker and who clears it, or that it is done. It leaves out commit SHAs, CI runs and logs, review findings and agent run ids: those stay on the pull request, and the pull request goes in the item's links.";

const createItem = createRoute({
  method: "post",
  path: "/items",
  summary: "Add a todo, file an issue or add a note",
  description: `Needs the issues action on a key that reaches the product. ${WHICH_ITEM} ${TODO_OR_ISSUE} A note starts current, with no assignee and no triage, on any product an issue may be filed on; about names the items it is about. A todo without product goes to the one product you own; with none or several, the 422 lists the products to pick from. An issue with project joins that project as it is filed; a key that reaches a product only through a project files there with project. An issue you file on behalf of the person you work for takes filed_for "handler" and is filed for your handler (GET /whoami shows who); leave it out for your own work. With no handler set it is a 422 naming the \`trail bot handler\` command the operator runs, and on a todo or a note a 422. It gets the product's next number, so its key reads like TRL-12.`,
  tags,
  request: {
    headers: idempotencyHeaders,
    body: jsonBody(itemCreateSchema),
  },
  responses: {
    201: jsonContent(createdItemSchema, "The created item"),
    ...forbiddenError("issues", {
      owner: OWNER_ONLY,
      scope: VIA_PROJECT_FILING,
    }),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listItems = createRoute({
  method: "get",
  path: "/items",
  summary:
    "List items newest first, filtered by product, project, type, status, assignee or about",
  description:
    "Without type, issues and todos only: notes are listed with type note or about, and status current or archived goes with them. about, an item's key like TRL-12, lists every note about that item this key reaches, archived ones too, paged like any list; it implies type note, so type todo or issue beside it is a 422, and so is a key this key doesn't reach.",
  tags,
  request: { query: itemListQuerySchema },
  responses: {
    200: jsonContent(pageSchema(issueSchema), "A page of items"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const getItem = createRoute({
  method: "get",
  path: "/items/{key}",
  summary: "Get an item",
  description: `A note carries about, the items it is about; every item carries notes, the ${ITEM_NOTES_MAX} newest current notes about it, and notesCount, every note about it per status. All three cover only what this key reaches; GET /items with about set to the item's key pages through every note about it, archived ones too.`,
  tags,
  request: { params: itemParam },
  responses: {
    200: jsonContent(issueSchema, "The item"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const updateItem = createRoute({
  method: "patch",
  path: "/items/{key}",
  summary:
    "Change an item's type, status, assignee, title, description, estimate, priority, labels or links, or the items a note is about",
  description: `Needs the issues action. ${TODO_OR_ISSUE} ${NOTE_EDITS} Accept an issue from triage with status open and assignee, the bot that will work on it (status open alone leaves it unassigned), or drop it with canceled. On a product with an owner, only the owner or the item's filer cancels it, at any status, and only the owner reopens a canceled issue another bot filed. type todo on an item in triage opens it and assigns the product's owner when it has no assignee; a todo never goes back to triage and never loses its assignee. Fields left out stay as they are; addLabels, removeLabels, addLinks and removeLinks change part of a set in the same transaction. On a product another bot owns, labels and addLabels attach only the product's existing labels and create none; the answer lists the names left off in skippedLabels. Moving to done or canceled stamps completedAt; reopening clears it. ${ENDING_EMAIL}`,
  tags,
  request: { params: itemParam, body: jsonBody(itemUpdateSchema) },
  responses: {
    200: jsonContent(
      updatedItemSchema,
      "The updated item, with skippedLabels when labels another bot's product lacks were left off",
    ),
    ...forbiddenError("issues", {
      owner: `${OWNER_ONLY}; or the item is a note and the key's bot is neither its author nor the product's owner: the message names who edits it and says to comment with add_comment instead; or the update turns an item into a note or a note into work and the product has no owner bot: nobody can, and the message says what to do instead`,
      scope: VIA_PROJECT,
    }),
    ...writeErrors,
    ...notFoundError,
  },
});

const addComment = createRoute({
  method: "post",
  path: "/items/{key}/comments",
  summary: "Comment on an item: a todo, an issue or a note",
  description: COMMENT_HOLDS,
  tags,
  request: {
    params: itemParam,
    headers: idempotencyHeaders,
    body: jsonBody(commentCreateSchema),
  },
  responses: {
    201: jsonContent(
      createdCommentSchema,
      "The created comment, with hint when its body reads like a build log",
    ),
    ...forbiddenError("comments"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listComments = createRoute({
  method: "get",
  path: "/items/{key}/comments",
  summary: "List an item's comments, oldest first",
  tags,
  request: { params: itemParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(pageSchema(commentSchema), "A page of comments"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

export function itemRoutes(service: Service) {
  return createRouter()
    .openapi(createItem, (c) => {
      const { type, ...input } = c.req.valid("json");
      const options = {
        idempotencyKey: c.req.valid("header")["idempotency-key"],
      };
      const created =
        type === "todo"
          ? service.addTodo(c.var.actor, input, options)
          : type === "note"
            ? service.addNote(c.var.actor, input, options)
            : service.fileIssue(c.var.actor, input, options);
      return c.json(withSkippedLabels(toIssue(created), created), 201);
    })
    .openapi(listItems, (c) =>
      c.json(
        toPage(service.listItems(c.var.actor, c.req.valid("query")), toIssue),
        200,
      ),
    )
    .openapi(getItem, (c) =>
      c.json(
        toIssue(service.getItem(c.var.actor, c.req.valid("param").key)),
        200,
      ),
    )
    .openapi(updateItem, (c) => {
      const { assignee, ...patch } = c.req.valid("json");
      const updated = service.updateItem(
        c.var.actor,
        c.req.valid("param").key,
        { ...patch, assigneeId: assignee },
      );
      return c.json(withSkippedLabels(toIssue(updated), updated), 200);
    })
    .openapi(addComment, (c) =>
      c.json(
        toCreatedComment(
          service.addComment(
            c.var.actor,
            { ...c.req.valid("json"), issueId: c.req.valid("param").key },
            { idempotencyKey: c.req.valid("header")["idempotency-key"] },
          ),
          "rest",
        ),
        201,
      ),
    )
    .openapi(listComments, (c) =>
      c.json(
        toPage(
          service.listComments(
            c.var.actor,
            c.req.valid("param").key,
            c.req.valid("query"),
          ),
          toComment,
        ),
        200,
      ),
    );
}
