import { createRoute, z } from "@hono/zod-openapi";
import {
  errorSchema,
  labelCreateSchema,
  labelSchema,
  legacyNamedProductSchema,
  legacyProductSchema,
  pageQuerySchema,
  pageSchema,
  projectCreateSchema,
  projectItemsAddedSchema,
  projectItemsRemovedSchema,
  projectItemsSchema,
  projectSchema,
  projectUpdateSchema,
  statusUpdateCreateSchema,
  statusUpdateSchema,
} from "../../shared/schemas.js";
import type {
  NamedProduct,
  ProductView,
  ProjectOrProduct,
  Service,
} from "../service/index.js";
import { deprecations } from "./deprecations.js";
import { createRouter } from "./env.js";
import {
  conflictError,
  forbiddenError,
  idempotencyHeaders,
  jsonBody,
  jsonContent,
  LABEL_CREATORS,
  notFoundError,
  OWNER_CREATES_LABELS,
  projectItemParam,
  projectParam,
  projectSlugParam,
  readErrors,
  VIA_PROJECT,
  writeErrors,
} from "./routes.js";
import {
  deprecated,
  toLabel,
  toPage,
  toProduct,
  toProductRead,
  toProject,
  toStatusUpdate,
} from "./serialize.js";

const tags = ["projects"];

const projectOrProduct = z.union([projectSchema, legacyProductSchema]);
const projectOrProductRead = z.union([
  projectSchema,
  legacyProductSchema,
  legacyNamedProductSchema,
]);

/** A project as it is, or a product the legacy way, with the note naming its replacement. */
const viewOf = (
  found: ProjectOrProduct,
  note: string = deprecations.product,
) =>
  found.kind === "project"
    ? toProject(found.project)
    : deprecated(toProduct(found.product), note);

/** `viewOf` for a read, where a product the key reaches only through a project is named only. */
const readOf = (found: ProjectOrProduct<ProductView | NamedProduct>) =>
  found.kind === "project"
    ? viewOf(found)
    : deprecated(toProductRead(found.product), deprecations.product);

const WHO_CHANGES =
  "Needs the issues action on a key that reaches at least one of the project's products.";

const createProject = createRoute({
  method: "post",
  path: "/projects",
  summary: "Create a project grouping items from one or more products",
  description: `${WHO_CHANGES} products defaults to the one product you own; the key must reach each product named. lead (a bot's name or id) defaults to you; slug is derived from the name when left out. Deprecated: a body with key creates a product, as this route did before projects (the response then carries deprecated); use POST /products.`,
  tags,
  request: {
    headers: idempotencyHeaders,
    body: jsonBody(projectCreateSchema),
  },
  responses: {
    201: jsonContent(
      projectOrProduct,
      "The created project (or, with key, the product)",
    ),
    403: jsonContent(
      errorSchema,
      "The key lacks the issues action, or with key the admin action (code forbidden_action), or with key reaches only some products (code forbidden_scope)",
    ),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listProjects = createRoute({
  method: "get",
  path: "/projects",
  summary: "List projects, newest first",
  description:
    "Only projects drawing from a product this key reaches; each shows only those products, with hiddenProducts true when it draws from others. Before projects existed this listed products: use GET /products for those. The page carries deprecated saying so for one release.",
  tags,
  request: { query: pageQuerySchema },
  responses: {
    200: jsonContent(
      pageSchema(projectSchema).extend({ deprecated: z.string() }),
      "A page of projects",
    ),
    ...forbiddenError("read"),
    ...readErrors,
  },
});

const getProject = createRoute({
  method: "get",
  path: "/projects/{ref}",
  summary: "Get a project by slug",
  description:
    "Deprecated: a product key that matches no slug returns the product, carrying deprecated; use GET /products/{key}. The project's items are listed by GET /items?project={slug}.",
  tags,
  request: { params: projectParam },
  responses: {
    200: jsonContent(projectOrProductRead, "The project"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const updateProject = createRoute({
  method: "patch",
  path: "/projects/{ref}",
  summary: "Change a project's name, goal, lead or targetDate",
  description: `${WHO_CHANGES} Fields left out stay as they are. Deprecated: a product key that matches no slug changes that product's name or description (admin action), carrying deprecated; use PATCH /products/{key}.`,
  tags,
  request: { params: projectParam, body: jsonBody(projectUpdateSchema) },
  responses: {
    200: jsonContent(projectOrProduct, "The updated project"),
    403: jsonContent(
      errorSchema,
      "The key lacks the issues action, or for a product key the admin action (code forbidden_action)",
    ),
    ...writeErrors,
    ...notFoundError,
  },
});

const addItems = createRoute({
  method: "post",
  path: "/projects/{slug}/items",
  summary: "Add items, from any products, to a project",
  description: `${WHO_CHANGES} Each item must be one this key reaches; its product joins the project's products when it isn't one yet. An item already in the project is left as it is and listed in unchanged, so a retry is safe. At most 100 items a call.`,
  tags,
  request: { params: projectSlugParam, body: jsonBody(projectItemsSchema) },
  responses: {
    200: jsonContent(projectItemsAddedSchema, "The project and what changed"),
    ...forbiddenError("issues", { scope: VIA_PROJECT }),
    ...writeErrors,
    ...notFoundError,
  },
});

const removeItem = createRoute({
  method: "delete",
  path: "/projects/{slug}/items/{key}",
  summary: "Take an item out of a project",
  description: `${WHO_CHANGES} An item not in the project is listed in unchanged, so a retry is safe. The project keeps its products.`,
  tags,
  request: { params: projectItemParam },
  responses: {
    200: jsonContent(projectItemsRemovedSchema, "The project and what changed"),
    ...forbiddenError("issues", { scope: VIA_PROJECT }),
    ...readErrors,
    ...notFoundError,
  },
});

const postStatusUpdate = createRoute({
  method: "post",
  path: "/projects/{ref}/status-updates",
  summary: "Post a project status update: a body and a health",
  description:
    "Needs the status_updates action on a key that reaches one of the project's products. externalRef is refused here with a 422, since only a product's update keeps one: send the Idempotency-Key header to make the post safe to retry. Deprecated: a product key that matches no slug posts on that product, carrying deprecated; use POST /products/{key}/status-updates.",
  tags,
  request: {
    params: projectParam,
    headers: idempotencyHeaders,
    body: jsonBody(statusUpdateCreateSchema),
  },
  responses: {
    201: jsonContent(
      statusUpdateSchema.extend({ deprecated: z.string().optional() }),
      "The created status update",
    ),
    ...forbiddenError("status_updates"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listStatusUpdates = createRoute({
  method: "get",
  path: "/projects/{ref}/status-updates",
  summary: "List a project's status updates, newest first",
  description:
    "Deprecated: a product key that matches no slug lists that product's, carrying deprecated; use GET /products/{key}/status-updates.",
  tags,
  request: { params: projectParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(
      pageSchema(statusUpdateSchema).extend({
        deprecated: z.string().optional(),
      }),
      "A page of status updates",
    ),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const labelTags = ["labels (deprecated)"];

const createLabel = createRoute({
  method: "post",
  path: "/projects/{ref}/labels",
  summary:
    "Deprecated: create a label in a product (use POST /products/{key}/labels)",
  description: `Deprecated alias of POST /products/{key}/labels, removed after the next release: ref is a product's key. Projects have no labels of their own. ${LABEL_CREATORS}`,
  deprecated: true,
  tags: labelTags,
  request: {
    params: projectParam,
    headers: idempotencyHeaders,
    body: jsonBody(labelCreateSchema),
  },
  responses: {
    201: jsonContent(
      labelSchema.extend({ deprecated: z.string() }),
      "The created label",
    ),
    ...forbiddenError("admin", { owner: OWNER_CREATES_LABELS }),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listLabels = createRoute({
  method: "get",
  path: "/projects/{ref}/labels",
  summary:
    "Deprecated: list a product's labels (use GET /products/{key}/labels)",
  description:
    "Deprecated alias of GET /products/{key}/labels, removed after the next release: ref is a product's key.",
  deprecated: true,
  tags: labelTags,
  request: { params: projectParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(
      pageSchema(labelSchema).extend({ deprecated: z.string() }),
      "A page of labels",
    ),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

export function projectRoutes(service: Service) {
  /** A status update target for `ref`: a project's slug, else a product key by the legacy meaning. */
  const targetOf = (
    actor: Parameters<Service["whichProjectRef"]>[0],
    ref: string,
  ) =>
    service.whichProjectRef(actor, ref) === "project"
      ? { target: { project: ref }, note: undefined }
      : { target: { product: ref }, note: deprecations.product };

  return createRouter()
    .openapi(createProject, (c) =>
      c.json(
        viewOf(
          service.createProjectOrProduct(c.var.actor, c.req.valid("json"), {
            idempotencyKey: c.req.valid("header")["idempotency-key"],
          }),
          deprecations.createProduct,
        ),
        201,
      ),
    )
    .openapi(listProjects, (c) =>
      c.json(
        deprecated(
          toPage(
            service.listProjects(c.var.actor, c.req.valid("query")),
            toProject,
          ),
          deprecations.listProjects,
        ),
        200,
      ),
    )
    .openapi(getProject, (c) =>
      c.json(
        readOf(
          service.getProjectOrProduct(c.var.actor, c.req.valid("param").ref),
        ),
        200,
      ),
    )
    .openapi(updateProject, (c) =>
      c.json(
        viewOf(
          service.updateProjectOrProduct(
            c.var.actor,
            c.req.valid("param").ref,
            c.req.valid("json"),
          ),
        ),
        200,
      ),
    )
    .openapi(addItems, (c) => {
      const result = service.addToProject(
        c.var.actor,
        c.req.valid("param").slug,
        c.req.valid("json").items,
      );
      return c.json({ ...result, project: toProject(result.project) }, 200);
    })
    .openapi(removeItem, (c) => {
      const { slug, key } = c.req.valid("param");
      const result = service.removeFromProject(c.var.actor, slug, [key]);
      return c.json({ ...result, project: toProject(result.project) }, 200);
    })
    .openapi(postStatusUpdate, (c) => {
      const { target, note } = targetOf(c.var.actor, c.req.valid("param").ref);
      const created = toStatusUpdate(
        service.createStatusUpdate(
          c.var.actor,
          { ...c.req.valid("json"), ...target },
          { idempotencyKey: c.req.valid("header")["idempotency-key"] },
        ),
      );
      return c.json(
        note === undefined ? created : deprecated(created, note),
        201,
      );
    })
    .openapi(listStatusUpdates, (c) => {
      const { target, note } = targetOf(c.var.actor, c.req.valid("param").ref);
      const found = toPage(
        service.listStatusUpdates(c.var.actor, target, c.req.valid("query")),
        toStatusUpdate,
      );
      return c.json(note === undefined ? found : deprecated(found, note), 200);
    })
    .openapi(createLabel, (c) =>
      c.json(
        deprecated(
          toLabel(
            service.createLabel(
              c.var.actor,
              { ...c.req.valid("json"), productId: c.req.valid("param").ref },
              { idempotencyKey: c.req.valid("header")["idempotency-key"] },
            ),
          ),
          deprecations.labels,
        ),
        201,
      ),
    )
    .openapi(listLabels, (c) =>
      c.json(
        deprecated(
          toPage(
            service.listLabels(
              c.var.actor,
              c.req.valid("param").ref,
              c.req.valid("query"),
            ),
            toLabel,
          ),
          deprecations.labels,
        ),
        200,
      ),
    );
}
