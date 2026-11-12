import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  actor,
  comment,
  issue,
  label,
  project,
  projectStatusUpdate,
} from "../db/schema.js";
import type { ActivityEvent } from "../events/bus.js";

/** How much of an event's payload a webhook carries, in characters of its JSON. */
export const PAYLOAD_MAX_CHARS = 2000;

/** The public origin links point at when none is configured. */
export const DEFAULT_PUBLIC_URL = "https://trail-justin.fly.dev";

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
  /** the issue's key (BGP-12) for an issue or a comment on it; the project's key otherwise */
  key: string | null;
  title: string | null;
};

function issueSubject(db: Db, issueId: string) {
  return db
    .select({
      number: issue.number,
      title: issue.title,
      projectKey: project.key,
    })
    .from(issue)
    .innerJoin(project, eq(project.id, issue.projectId))
    .where(eq(issue.id, issueId))
    .get();
}

function subjectOf(
  db: Db,
  event: ActivityEvent,
  projectKey: string | null,
  projectName: string | null,
): { subject: Subject; path: string } {
  const base = { type: event.subjectType, id: event.subjectId };
  const projectPath = projectKey === null ? "/" : `/projects/${projectKey}`;
  switch (event.subjectType) {
    case "issue": {
      const row = issueSubject(db, event.subjectId);
      if (!row) break;
      const key = `${row.projectKey}-${row.number}`;
      return {
        subject: { ...base, key, title: row.title },
        path: `/issues/${key}`,
      };
    }
    case "comment": {
      const row = db
        .select({ issueId: comment.issueId })
        .from(comment)
        .where(eq(comment.id, event.subjectId))
        .get();
      const found = row && issueSubject(db, row.issueId);
      if (!found) break;
      const key = `${found.projectKey}-${found.number}`;
      return {
        subject: { ...base, key, title: found.title },
        path: `/issues/${key}`,
      };
    }
    case "label": {
      const row = db
        .select({ name: label.name })
        .from(label)
        .where(eq(label.id, event.subjectId))
        .get();
      return {
        subject: { ...base, key: projectKey, title: row?.name ?? null },
        path: projectPath,
      };
    }
    case "status_update": {
      const row = db
        .select({ health: projectStatusUpdate.health })
        .from(projectStatusUpdate)
        .where(
          and(
            eq(projectStatusUpdate.id, event.subjectId),
            event.projectId === null
              ? undefined
              : eq(projectStatusUpdate.projectId, event.projectId),
          ),
        )
        .get();
      return {
        subject: {
          ...base,
          key: projectKey,
          title: row ? `Status update: ${row.health}` : null,
        },
        path: projectPath,
      };
    }
    default:
      break;
  }
  return {
    subject: { ...base, key: projectKey, title: projectName },
    path: projectPath,
  };
}

/** The webhook body for a committed event, as OpenBot's signed-webhook routine reads it. */
export function buildEnvelope(
  db: Db,
  event: ActivityEvent,
  publicUrl: string,
): Envelope {
  const proj =
    event.projectId === null
      ? undefined
      : db
          .select({ key: project.key, name: project.name })
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
    proj?.key ?? null,
    proj?.name ?? null,
  );
  return {
    type: `trail.${event.action}`,
    occurredAt: event.createdAt.toISOString(),
    data: {
      eventId: event.id,
      seq: event.seq,
      project: proj ? { key: proj.key, name: proj.name } : null,
      subject,
      actor: by ? { name: by.name, kind: by.kind } : null,
      url: `${publicUrl.replace(/\/+$/, "")}${path}`,
      payload: cutPayload(event.payload),
    },
  };
}
