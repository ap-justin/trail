import { createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { errorSchema, myPhotoSchema } from "../../shared/schemas.js";
import { actorPhotoContentTypes } from "../db/schema.js";
import type { Service } from "../service/index.js";
import {
  PHOTO_ACCEPTS,
  PHOTO_MAX_BYTES,
  photoTooLarge,
} from "../service/photos.js";
import { createRouter } from "./env.js";
import { errorResponse } from "./errors.js";
import { jsonContent, limitBody, readErrors } from "./routes.js";

const tags = ["actors"];
const anyKey =
  "Acts only on the calling bot. Every key may call it, whatever projects and actions it is limited to.";

const imageBody = {
  content: Object.fromEntries(
    actorPhotoContentTypes.map((type) => [
      type,
      { schema: z.string().openapi({ format: "binary" }) },
    ]),
  ),
  required: true,
};

/** 415 unless the declared Content-Type is one a photo may be; parameters are ignored. */
const requireImageType = createMiddleware(async (c, next) => {
  const declared = c.req.header("content-type");
  const essence = declared?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(actorPhotoContentTypes as readonly string[]).includes(essence)) {
    return errorResponse(
      c,
      415,
      "unsupported_media_type",
      `the photo was sent as ${declared ? `Content-Type ${declared}` : "no Content-Type"}: send its raw bytes with Content-Type ${actorPhotoContentTypes.join(", ")}`,
    );
  }
  await next();
});

const setPhoto = createRoute({
  method: "put",
  path: "/me/photo",
  summary: "Set the calling bot's photo",
  description: `${anyKey} The body is the image's raw bytes, ${PHOTO_ACCEPTS}. Its type is read from the bytes, which win over the declared Content-Type. A new photo replaces the old one, and its URL changes.`,
  tags,
  middleware: [
    requireImageType,
    limitBody(PHOTO_MAX_BYTES, photoTooLarge(null)),
  ] as const,
  request: { body: imageBody },
  responses: {
    200: jsonContent(myPhotoSchema, "The new photo's URL"),
    401: readErrors[401],
    413: jsonContent(errorSchema, `The body is over ${PHOTO_MAX_BYTES} bytes`),
    415: jsonContent(
      errorSchema,
      "The Content-Type is not image/png, image/jpeg or image/webp",
    ),
    422: jsonContent(
      errorSchema,
      "The bytes are empty or not a PNG, JPEG or WebP image (code invalid_image)",
    ),
  },
});

const clearPhoto = createRoute({
  method: "delete",
  path: "/me/photo",
  summary: "Remove the calling bot's photo",
  description: `${anyKey} Removing a photo the bot doesn't have succeeds too.`,
  tags,
  responses: {
    200: jsonContent(myPhotoSchema, "photoUrl null"),
    401: readErrors[401],
  },
});

export function photoRoutes(service: Service) {
  return createRouter()
    .openapi(setPhoto, async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return c.json(service.setMyPhoto(c.var.actor, bytes), 200);
    })
    .openapi(clearPhoto, (c) => c.json(service.clearMyPhoto(c.var.actor), 200));
}
