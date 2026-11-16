import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  actor,
  comment,
  issue,
  label,
  product,
  productStatusUpdate,
  project,
  projectStatusUpdate,
} from "../db/schema.js";
import type { ActivityEvent } from "../events/bus.js";
import { findMessage, MESSAGE_RECEIVED } from "../service/messages.js";

/** How much of an event's payload a webhook carries, in characters of its JSON. */
export const PAYLOAD_MAX_CHARS = 2000;

export type Envelope = {
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
};

/** The payload as is when its JSON fits, else its first `PAYLOAD_MAX_CHARS` characters. */
export function cutPayload(payload: Record<string, unknown>): unknown {
  const text = JSON.stringify(payload);
  if (text.length <= PAYLOAD_MAX_CHARS) return payload;
  return { truncated: true, json: text.slice(0, PAYLOAD_MAX_CHARS) };
}

type Subject = {
  type: string;
  id: string;
  /** an item's key (ATL-12) for an item or a comment on one; a project's slug for a project; the product's key otherwise */
  key: string | null;
  title: string | null;
  /** issue or todo, on an item or a comment on one */
  itemType?: string;
};

function issueSubject(db: Db, issueId: string) {
  return db
    .select({
      number: issue.number,
      title: issue.title,
      type: issue.type,
      productKey: product.key,
    })
    .from(issue)
    .innerJoin(product, eq(product.id, issue.productId))
    .where(eq(issue.id, issueId))
    .get();
}

type ProjectRef = { slug: string; name: string };

function subjectOf(
  db: Db,
  event: ActivityEvent,
  productKey: string | null,
  productName: string | null,
  proj: ProjectRef | undefined,
): { subject: Subject; path: string } {
  const base = { type: event.subjectType, id: event.subjectId };
  const ownerPath =
    proj !== undefined
      ? `/projects/${proj.slug}`
      : productKey === null
        ? "/"
        : `/products/${productKey}`;
  const ownerKey = proj?.slug ?? productKey;
  const itemSubject = (issueId: string) => {
    const row = issueSubject(db, issueId);
    if (!row) return undefined;
    const key = `${row.productKey}-${row.number}`;
    return {
      subject: { ...base, key, title: row.title, itemType: row.type },
      path: `/issues/${key}`,
    };
  };
  switch (event.subjectType) {
    case "issue": {
      const found = itemSubject(event.subjectId);
      if (found) return found;
      break;
    }
    case "comment": {
      const row = db
        .select({ issueId: comment.issueId })
        .from(comment)
        .where(eq(comment.id, event.subjectId))
        .get();
      const found = row && itemSubject(row.issueId);
      if (found) return found;
      break;
    }
    case "label": {
      const row = db
        .select({ name: label.name })
        .from(label)
        .where(eq(label.id, event.subjectId))
        .get();
      return {
        subject: { ...base, key: productKey, title: row?.name ?? null },
        path: ownerPath,
      };
    }
    case "status_update": {
      const table =
        proj === undefined ? productStatusUpdate : projectStatusUpdate;
      const row = db
        .select({ health: table.health })
        .from(table)
        .where(eq(table.id, event.subjectId))
        .get();
      return {
        subject: {
          ...base,
          key: ownerKey,
          title: row ? `Status update: ${row.health}` : null,
        },
        path: ownerPath,
      };
    }
    case "project":
      return {
        subject: {
          ...base,
          key: proj?.slug ?? null,
          title: proj?.name ?? null,
        },
        path: ownerPath,
      };
    default:
      break;
  }
  return {
    subject: { ...base, key: productKey, title: productName },
    path: ownerPath,
  };
}

/** The webhook body for a committed event, as OpenBot's signed-webhook routine reads it. */
export function buildEnvelope(
  db: Db,
  event: ActivityEvent,
  publicUrl: string | undefined,
): Envelope {
  const prod =
    event.productId === null
      ? undefined
      : db
          .select({ key: product.key, name: product.name })
          .from(product)
          .where(eq(product.id, event.productId))
          .get();
  const proj =
    event.projectId === null
      ? undefined
      : db
          .select({ slug: project.slug, name: project.name })
          .from(project)
          .where(eq(project.id, event.projectId))
          .get();
  const by = db
    .select({ name: actor.displayName, kind: actor.kind })
    .from(actor)
    .where(eq(actor.id, event.actorId))
    .get();
  const { subject, path } = subjectOf(
    db,
    event,
    prod?.key ?? null,
    prod?.name ?? null,
    // an item's membership event links to the item, not the project
    event.subjectType === "issue" ? undefined : proj,
  );
  const productRef = prod ? { key: prod.key, name: prod.name } : null;
  return {
    type: `trail.${event.action}`,
    occurredAt: event.createdAt.toISOString(),
    data: {
      eventId: event.id,
      seq: event.seq,
      product: productRef,
      // deprecated alias of product, kept for one release
      project: productRef,
      projectSlug: proj?.slug ?? null,
      subject,
      actor: by ? { name: by.name, kind: by.kind } : null,
      ...(publicUrl !== undefined && {
        url: `${publicUrl.replace(/\/+$/, "")}${path}`,
      }),
      payload: cutPayload(event.payload),
    },
  };
}

/**
 * The trail.message.received body for an inbox webhook: the whole message,
 * text never cut, so it is built apart from `cutPayload`. Undefined when the
 * message is gone.
 */
export function buildMessageEnvelope(
  db: Db,
  messageId: string,
): Envelope | undefined {
  const found = findMessage(db, messageId);
  if (!found) return undefined;
  const createdAt = found.createdAt.toISOString();
  return {
    type: MESSAGE_RECEIVED,
    occurredAt: createdAt,
    data: {
      message: {
        id: found.id,
        from: found.from,
        to: found.to,
        threadId: found.threadId,
        replyTo: found.replyToId,
        expectsReply: found.expectsReply,
        text: found.text,
        createdAt,
      },
    },
  };
}
