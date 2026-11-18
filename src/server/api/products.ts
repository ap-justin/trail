import { createRoute } from "@hono/zod-openapi";
import {
  labelCreateSchema,
  labelSchema,
  pageQuerySchema,
  pageSchema,
  productCreateSchema,
  productReadSchema,
  productSchema,
  productUpdateSchema,
  statusUpdateCreateSchema,
  statusUpdateSchema,
} from "../../shared/schemas.js";
import type { Service } from "../service/index.js";
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
  productParam,
  readErrors,
  writeErrors,
} from "./routes.js";
import {
  toLabel,
  toPage,
  toProduct,
  toProductRead,
  toStatusUpdate,
} from "./serialize.js";

const tags = ["products"];

const createProduct = createRoute({
  method: "post",
  path: "/products",
  summary: "Create a product",
  description:
    "Needs the admin action and a key that reaches every product. Its key (like TRL) prefixes its items' keys (TRL-1, TRL-2, ...) and must be unused. The calling bot owns it unless owner names another bot. To bring a product over from Linear, use POST /import.",
  tags,
  request: {
    headers: idempotencyHeaders,
    body: jsonBody(productCreateSchema),
  },
  responses: {
    201: jsonContent(productSchema, "The created product"),
    ...forbiddenError("admin", { scope: true }),
    ...writeErrors,
    ...conflictError,
  },
});

const listProducts = createRoute({
  method: "get",
  path: "/products",
  summary: "List the products this key reaches, newest first",
  tags,
  request: { query: pageQuerySchema },
  responses: {
    200: jsonContent(pageSchema(productReadSchema), "A page of products"),
    ...forbiddenError("read"),
    ...readErrors,
  },
});

const getProduct = createRoute({
  method: "get",
  path: "/products/{key}",
  summary: "Get a product with its owner and repoUrl",
  tags,
  request: { params: productParam },
  responses: {
    200: jsonContent(productReadSchema, "The product"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const updateProduct = createRoute({
  method: "patch",
  path: "/products/{key}",
  summary: "Change a product's name, description, repoUrl or owner",
  description:
    "Needs the admin action. Fields left out stay as they are; null clears repoUrl or owner. A product's owner changes only when it has none or the caller is its owner, who may hand it to another bot or clear it; anyone else gets a 403 (forbidden) naming the owner, and the operator reassigns it with `trail products set-owner`.",
  tags,
  request: { params: productParam, body: jsonBody(productUpdateSchema) },
  responses: {
    200: jsonContent(productSchema, "The updated product"),
    ...forbiddenError("admin", {
      owner: "owner changes the owner of a product another bot owns",
    }),
    ...writeErrors,
    ...notFoundError,
  },
});

export const STATUS_UPDATE_HOLDS =
  "A status update says where the project stands, its risks and what's next, not a changelog.";

const postStatusUpdate = createRoute({
  method: "post",
  path: "/products/{key}/status-updates",
  summary: "Post a product status update: a body and a health",
  description: STATUS_UPDATE_HOLDS,
  tags,
  request: {
    params: productParam,
    headers: idempotencyHeaders,
    body: jsonBody(statusUpdateCreateSchema),
  },
  responses: {
    201: jsonContent(statusUpdateSchema, "The created status update"),
    ...forbiddenError("status_updates"),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listStatusUpdates = createRoute({
  method: "get",
  path: "/products/{key}/status-updates",
  summary: "List a product's status updates, newest first",
  tags,
  request: { params: productParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(
      pageSchema(statusUpdateSchema),
      "A page of status updates",
    ),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

const createLabel = createRoute({
  method: "post",
  path: "/products/{key}/labels",
  summary: "Create a label in a product",
  description: `Needs the admin action. ${LABEL_CREATORS}`,
  tags,
  request: {
    params: productParam,
    headers: idempotencyHeaders,
    body: jsonBody(labelCreateSchema),
  },
  responses: {
    201: jsonContent(labelSchema, "The created label"),
    ...forbiddenError("admin", { owner: OWNER_CREATES_LABELS }),
    ...writeErrors,
    ...notFoundError,
    ...conflictError,
  },
});

const listLabels = createRoute({
  method: "get",
  path: "/products/{key}/labels",
  summary: "List a product's labels, oldest first",
  description:
    "A product the key names only through a project drawing from its products is a 404 here, whose message names that project and the grants that would list its labels; through a project the key lists, its labels are listed.",
  tags,
  request: { params: productParam, query: pageQuerySchema },
  responses: {
    200: jsonContent(pageSchema(labelSchema), "A page of labels"),
    ...forbiddenError("read"),
    ...readErrors,
    ...notFoundError,
  },
});

export function productRoutes(service: Service) {
  return createRouter()
    .openapi(createProduct, (c) =>
      c.json(
        toProduct(
          service.createProduct(c.var.actor, c.req.valid("json"), {
            idempotencyKey: c.req.valid("header")["idempotency-key"],
          }),
        ),
        201,
      ),
    )
    .openapi(listProducts, (c) =>
      c.json(
        toPage(
          service.listProducts(c.var.actor, c.req.valid("query")),
          toProductRead,
        ),
        200,
      ),
    )
    .openapi(getProduct, (c) =>
      c.json(
        toProductRead(
          service.getProduct(c.var.actor, c.req.valid("param").key),
        ),
        200,
      ),
    )
    .openapi(updateProduct, (c) =>
      c.json(
        toProduct(
          service.updateProduct(
            c.var.actor,
            c.req.valid("param").key,
            c.req.valid("json"),
          ),
        ),
        200,
      ),
    )
    .openapi(postStatusUpdate, (c) =>
      c.json(
        toStatusUpdate(
          service.createStatusUpdate(
            c.var.actor,
            { ...c.req.valid("json"), product: c.req.valid("param").key },
            { idempotencyKey: c.req.valid("header")["idempotency-key"] },
          ),
        ),
        201,
      ),
    )
    .openapi(listStatusUpdates, (c) =>
      c.json(
        toPage(
          service.listStatusUpdates(
            c.var.actor,
            { product: c.req.valid("param").key },
            c.req.valid("query"),
          ),
          toStatusUpdate,
        ),
        200,
      ),
    )
    .openapi(createLabel, (c) =>
      c.json(
        toLabel(
          service.createLabel(
            c.var.actor,
            { ...c.req.valid("json"), productId: c.req.valid("param").key },
            { idempotencyKey: c.req.valid("header")["idempotency-key"] },
          ),
        ),
        201,
      ),
    )
    .openapi(listLabels, (c) =>
      c.json(
        toPage(
          service.listLabels(
            c.var.actor,
            c.req.valid("param").key,
            c.req.valid("query"),
          ),
          toLabel,
        ),
        200,
      ),
    );
}
