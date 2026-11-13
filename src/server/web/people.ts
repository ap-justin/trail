import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, or, type SQL } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import {
  errorSchema,
  INVITEE_HINT,
  type PersonView,
  parseInvitee,
  peopleSchema,
  personCreateSchema,
  personSchema,
  personUpdateSchema,
} from "../../shared/schemas.js";
import { handleNotFound } from "../api/errors.js";
import { jsonBody, jsonContent } from "../api/routes.js";
import { endSessionsOfInvite } from "../auth/identity.js";
import type { Db } from "../db/client.js";
import {
  actor,
  actorPhoto,
  invite,
  project,
  projectMember,
} from "../db/schema.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../service/errors.js";
import { photoUrl, photoUrlOf } from "../service/photos.js";
import type { Tx } from "../service/tx.js";
import { createWebRouter, type WebEnv } from "./env.js";

// a person's {username}: the GitHub username, or the email address of an email invite
const usernameParam = z.object({ username: z.string().min(1) });

const listPeople = createRoute({
  method: "get",
  path: "/people",
  responses: {
    200: jsonContent(peopleSchema, "The owner, then each invite, oldest first"),
  },
});

const invitePerson = createRoute({
  method: "post",
  path: "/people",
  request: { body: jsonBody(personCreateSchema) },
  responses: {
    201: jsonContent(personSchema, "The invite"),
    409: jsonContent(errorSchema, "Already invited, or the owner"),
    422: jsonContent(
      errorSchema,
      "Neither a GitHub username nor an email address, or an unknown project key",
    ),
  },
});

const setProjects = createRoute({
  method: "put",
  path: "/people/{username}",
  request: { params: usernameParam, body: jsonBody(personUpdateSchema) },
  responses: {
    200: jsonContent(personSchema, "The invite with its new projects"),
    404: jsonContent(errorSchema, "No invite for that username or email"),
    422: jsonContent(errorSchema, "An unknown project key"),
  },
});

const removePerson = createRoute({
  method: "delete",
  path: "/people/{username}",
  request: { params: usernameParam },
  responses: {
    204: { description: "Removed; the person's actor and writes stay" },
    404: jsonContent(errorSchema, "No invite for that username or email"),
  },
});

// the same 404 as a route that doesn't exist: a member never learns /people is there
const ownerOnly = createMiddleware<WebEnv>(async (c, next) => {
  if (c.var.member.kind !== "owner") return handleNotFound(c);
  await next();
});

type Invitee = { username: string } | { email: string };

/** The invitee a {username} path segment names, read as `parseInvitee` reads an entry; one it can't read matches no invite. */
const inviteeOfParam = (param: string): Invitee =>
  parseInvitee(param) ?? { username: param.trim().toLowerCase() };

const handleOf = (invitee: Invitee) =>
  "email" in invitee ? invitee.email : `@${invitee.username}`;

const inviteFor = (invitee: Invitee): SQL =>
  "email" in invitee
    ? eq(invite.email, invitee.email)
    : eq(invite.username, invitee.username);

const noInvite = (invitee: Invitee) =>
  new NotFoundError(`no invite for ${handleOf(invitee)}`);

/** The ids of the projects with these keys, in any case; an unknown key is a 422 naming it. */
function projectIdsOf(tx: Tx, keys: string[]): string[] {
  const wanted = [...new Set(keys.map((k) => k.toUpperCase()))];
  if (wanted.length === 0) return [];
  const rows = tx
    .select({ id: project.id, key: project.key })
    .from(project)
    .where(inArray(project.key, wanted))
    .all();
  const missing = wanted.filter((k) => !rows.some((r) => r.key === k));
  if (missing.length > 0) {
    throw new ValidationError(
      `no project ${missing.join(", ")}: pass the keys of existing projects`,
    );
  }
  return rows.map((r) => r.id);
}

function setMemberships(tx: Tx, inviteId: number, projectIds: string[]) {
  tx.delete(projectMember).where(eq(projectMember.inviteId, inviteId)).run();
  if (projectIds.length === 0) return;
  tx.insert(projectMember)
    .values(projectIds.map((projectId) => ({ inviteId, projectId })))
    .run();
}

/** The invites with these ids, or every invite, oldest first. */
function invitees(db: Db | Tx, ids?: number[]): PersonView[] {
  const invites = db
    .select()
    .from(invite)
    .where(ids ? inArray(invite.id, ids) : undefined)
    .orderBy(asc(invite.createdAt), asc(invite.id))
    .all();
  if (invites.length === 0) return [];
  const memberships = db
    .select({
      inviteId: projectMember.inviteId,
      key: project.key,
      name: project.name,
    })
    .from(projectMember)
    .innerJoin(project, eq(project.id, projectMember.projectId))
    .where(
      inArray(
        projectMember.inviteId,
        invites.map((i) => i.id),
      ),
    )
    .orderBy(asc(project.key))
    .all();
  const claimedIds = invites.flatMap((i) =>
    i.githubId === null ? [] : [i.githubId],
  );
  const emails = invites.flatMap((i) => (i.email === null ? [] : [i.email]));
  const actors =
    claimedIds.length === 0 && emails.length === 0
      ? []
      : db
          .select({
            id: actor.id,
            githubId: actor.githubId,
            email: actor.email,
            name: actor.displayName,
            photoHash: actorPhoto.hash,
          })
          .from(actor)
          .leftJoin(actorPhoto, eq(actorPhoto.actorId, actor.id))
          .where(
            and(
              eq(actor.kind, "human"),
              or(
                inArray(actor.githubId, claimedIds),
                inArray(actor.email, emails),
              ),
            ),
          )
          .all();
  return invites.map((i) => {
    // a GitHub invite is the account that claimed it, whatever its login is now; an
    // email invite, the actor its address let in
    const person =
      i.githubId !== null
        ? actors.find((a) => a.githubId === i.githubId)
        : actors.find((a) => i.email !== null && a.email === i.email);
    return {
      username: i.username,
      email: i.email,
      owner: false,
      pending: person === undefined,
      name: person?.name ?? null,
      photoUrl: person ? photoUrl(person.id, person.photoHash) : null,
      projects: memberships
        .filter((m) => m.inviteId === i.id)
        .map(({ key, name }) => ({ key, name })),
      invitedAt: i.createdAt.toISOString(),
    };
  });
}

const one = (db: Db | Tx, id: number) => invitees(db, [id])[0] as PersonView;

export function peopleRoutes(db: Db) {
  const people = createWebRouter();
  people.use("/people", ownerOnly);
  people.use("/people/*", ownerOnly);
  return people
    .openapi(listPeople, (c) => {
      const owner = c.var.member;
      const ownerRow: PersonView = {
        username: owner.login,
        email: null,
        owner: true,
        pending: false,
        name: owner.actor.displayName,
        photoUrl: photoUrlOf(db, owner.actor.id),
        projects: owner.projects.map(({ key, name }) => ({ key, name })),
        invitedAt: null,
      };
      return c.json({ items: [ownerRow, ...invitees(db)] }, 200);
    })
    .openapi(invitePerson, (c) => {
      const owner = c.var.member;
      const { username: entry, projectKeys } = c.req.valid("json");
      const invitee = parseInvitee(entry);
      if (!invitee) throw new ValidationError(INVITEE_HINT);
      if ("username" in invitee && invitee.username === owner.login) {
        throw new ConflictError(
          `@${invitee.username} is the owner, who sees every project`,
        );
      }
      const created = db.transaction(
        (tx) => {
          const projectIds = projectIdsOf(tx, projectKeys);
          if (tx.select().from(invite).where(inviteFor(invitee)).get()) {
            throw new ConflictError(
              `${handleOf(invitee)} is already invited. Change their projects in the list below.`,
            );
          }
          const { id } = tx
            .insert(invite)
            .values({ ...invitee, invitedBy: owner.actor.id })
            .returning({ id: invite.id })
            .get();
          setMemberships(tx, id, projectIds);
          return one(tx, id);
        },
        { behavior: "immediate" },
      );
      return c.json(created, 201);
    })
    .openapi(setProjects, (c) => {
      const invitee = inviteeOfParam(c.req.valid("param").username);
      const { projectKeys } = c.req.valid("json");
      const updated = db.transaction(
        (tx) => {
          const found = tx
            .select({ id: invite.id })
            .from(invite)
            .where(inviteFor(invitee))
            .get();
          if (!found) throw noInvite(invitee);
          setMemberships(tx, found.id, projectIdsOf(tx, projectKeys));
          return one(tx, found.id);
        },
        { behavior: "immediate" },
      );
      return c.json(updated, 200);
    })
    .openapi(removePerson, (c) => {
      const invitee = inviteeOfParam(c.req.valid("param").username);
      db.transaction(
        (tx) => {
          // project_member rows go with it (on delete cascade)
          const removed = tx
            .delete(invite)
            .where(inviteFor(invitee))
            .returning()
            .get();
          if (!removed) throw noInvite(invitee);
          endSessionsOfInvite(tx, removed);
        },
        { behavior: "immediate" },
      );
      return c.body(null, 204);
    });
}
