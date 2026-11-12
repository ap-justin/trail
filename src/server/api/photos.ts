import { createRoute } from "@hono/zod-openapi";
import {
  errorSchema,
  myPhotoRemovedSchema,
  myPhotoSchema,
} from "../../shared/schemas.js";
import { actorPhotoContentTypes } from "../db/schema.js";
import { InvalidImageError } from "../service/errors.js";
import type { Service } from "../service/index.js";
import {
  PHOTO_ACCEPTS,
  PHOTO_MAX_BYTES,
  photoTooLarge,
} from "../service/photos.js";
import { createRouter } from "./env.js";
import { jsonContent, limitBody, readErrors } from "./routes.js";

const tags = ["actors"];
const anyKey =
  "Acts only on the calling bot. Every key may call it, whatever projects and actions it is limited to.";

// no schema: in OpenAPI 3.1 raw bytes are the media type alone. */* because
// the route takes any Content-Type and reads the type from the bytes
const imageBody = {
  content: Object.fromEntries(
    [...actorPhotoContentTypes, "*/*"].map((type) => [type, {}]),
  ),
  required: true,
};

// a form's body starts with its boundary, so the byte sniff would call a real image "not an image"
const isMultipartForm = (contentType: string | undefined) =>
  contentType?.trimStart().toLowerCase().startsWith("multipart/form-data") ??
  false;

const setPhoto = createRoute({
  method: "put",
  path: "/me/photo",
  summary: "Set the calling bot's photo",
  description: `${anyKey} The body is the image's raw bytes, ${PHOTO_ACCEPTS}. Its type is read from the bytes, so curl's --data-binary default and application/octet-stream are fine; the one Content-Type refused is multipart/form-data (curl -F, a FormData body): send the image itself as the body, not a form. A new photo replaces the old one, and its URL changes.`,
  tags,
  middleware: [limitBody(PHOTO_MAX_BYTES, photoTooLarge(null))] as const,
  request: { body: imageBody },
  responses: {
    200: jsonContent(myPhotoSchema, "The new photo's URL"),
    401: readErrors[401],
    413: jsonContent(errorSchema, `The body is over ${PHOTO_MAX_BYTES} bytes`),
    422: jsonContent(
      errorSchema,
      "The bytes are empty or not a PNG, JPEG or WebP image, or the body is a multipart form (code invalid_image)",
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
    200: jsonContent(myPhotoRemovedSchema, "The photo is gone"),
    401: readErrors[401],
  },
});

export function photoRoutes(service: Service) {
  return createRouter()
    .openapi(setPhoto, async (c) => {
      if (isMultipartForm(c.req.header("content-type"))) {
        throw new InvalidImageError(
          `the photo was sent as a multipart form: send the image's raw bytes as the request body, not a form (curl --data-binary @me.png, not -F), ${PHOTO_ACCEPTS}`,
        );
      }
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return c.json(service.setMyPhoto(c.var.actor, bytes), 200);
    })
    .openapi(clearPhoto, (c) => c.json(service.clearMyPhoto(c.var.actor), 200));
}
