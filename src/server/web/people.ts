import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import {
  errorSchema,
  type PersonView,
  peopleSchema,
  personCreateSchema,
  personSchema,
  personUpdateSchema,
} from "../../shared/schemas.js";
import { handleNotFound } from "../api/errors.js";
import { jsonBody, jsonContent } from "../api/routes.js";
import type { Db } from "../db/client.js";
import { actor, invite, project, projectMember } from "../db/schema.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../service/errors.js";
import type { Tx } from "../service/tx.js";
import { createWebRouter, type WebEnv } from "./env.js";

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
      "Not a GitHub username, or an unknown project key",
    ),
  },
});

const setProjects = createRoute({
  method: "put",
  path: "/people/{username}",
  request: { params: usernameParam, body: jsonBody(personUpdateSchema) },
  responses: {
    200: jsonContent(personSchema, "The invite with its new projects"),
    404: jsonContent(errorSchema, "No invite for that username"),
    422: jsonContent(errorSchema, "An unknown project key"),
  },
});

const removePerson = createRoute({
  method: "delete",
  path: "/people/{username}",
  request: { params: usernameParam },
  responses: {
    204: { description: "Removed; the person's actor and writes stay" },
    404: jsonContent(errorSchema, "No invite for that username"),
  },
});

// the same 404 as a route that doesn't exist: a member never learns /people is there
const ownerOnly = createMiddleware<WebEnv>(async (c, next) => {
  if (c.var.member.kind !== "owner") return handleNotFound(c);
  await next();
});

const noInvite = (username: string) =>
  new NotFoundError(`no invite for @${username}`);

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

function setMemberships(tx: Tx, username: string, projectIds: string[]) {
  tx.delete(projectMember).where(eq(projectMember.username, username)).run();
  if (projectIds.length === 0) return;
  tx.insert(projectMember)
    .values(projectIds.map((projectId) => ({ username, projectId })))
    .run();
}

/** The invites for these usernames, or every invite, oldest first. */
function invitees(db: Db | Tx, usernames?: string[]): PersonView[] {
  const invites = db
    .select()
    .from(invite)
    .where(usernames ? inArray(invite.username, usernames) : undefined)
    .orderBy(asc(invite.createdAt), asc(invite.username))
    .all();
  const names = invites.map((i) => i.username);
  if (names.length === 0) return [];
  const memberships = db
    .select({
      username: projectMember.username,
      key: project.key,
      name: project.name,
    })
    .from(projectMember)
    .innerJoin(project, eq(project.id, projectMember.projectId))
    .where(inArray(projectMember.username, names))
    .orderBy(asc(project.key))
    .all();
  const actors = db
    .select({ login: actor.githubLogin, name: actor.displayName })
    .from(actor)
    .where(and(eq(actor.kind, "human"), inArray(actor.githubLogin, names)))
    .all();
  return invites.map((i) => {
    const signedIn = actors.find((a) => a.login === i.username);
    return {
      username: i.username,
      owner: false,
      pending: !signedIn,
      name: signedIn?.name ?? null,
      projects: memberships
        .filter((m) => m.username === i.username)
        .map(({ key, name }) => ({ key, name })),
      invitedAt: i.createdAt.toISOString(),
    };
  });
}

const one = (db: Db | Tx, username: string) =>
  invitees(db, [username])[0] as PersonView;

export function peopleRoutes(db: Db) {
  const people = createWebRouter();
  people.use("/people", ownerOnly);
  people.use("/people/*", ownerOnly);
  return people
    .openapi(listPeople, (c) => {
      const owner = c.var.member;
      const ownerRow: PersonView = {
        username: owner.login,
        owner: true,
        pending: false,
        name: owner.actor.displayName,
        projects: owner.projects.map(({ key, name }) => ({ key, name })),
        invitedAt: null,
      };
      return c.json({ items: [ownerRow, ...invitees(db)] }, 200);
    })
    .openapi(invitePerson, (c) => {
      const owner = c.var.member;
      const { username, projectKeys } = c.req.valid("json");
      if (username === owner.login) {
        throw new ConflictError(
          `@${username} is the owner, who sees every project`,
        );
      }
      const created = db.transaction(
        (tx) => {
          const projectIds = projectIdsOf(tx, projectKeys);
          const taken = tx
            .select()
            .from(invite)
            .where(eq(invite.username, username))
            .get();
          if (taken) {
            throw new ConflictError(
              `@${username} is already invited: change their projects instead`,
            );
          }
          tx.insert(invite)
            .values({ username, invitedBy: owner.actor.id })
            .run();
          setMemberships(tx, username, projectIds);
          return one(tx, username);
        },
        { behavior: "immediate" },
      );
      return c.json(created, 201);
    })
    .openapi(setProjects, (c) => {
      const username = c.req.valid("param").username.toLowerCase();
      const { projectKeys } = c.req.valid("json");
      const updated = db.transaction(
        (tx) => {
          const found = tx
            .select()
            .from(invite)
            .where(eq(invite.username, username))
            .get();
          if (!found) throw noInvite(username);
          setMemberships(tx, username, projectIdsOf(tx, projectKeys));
          return one(tx, username);
        },
        { behavior: "immediate" },
      );
      return c.json(updated, 200);
    })
    .openapi(removePerson, (c) => {
      const username = c.req.valid("param").username.toLowerCase();
      // project_member rows go with it (on delete cascade)
      const { changes } = db
        .delete(invite)
        .where(eq(invite.username, username))
        .run();
      if (changes === 0) throw noInvite(username);
      return c.body(null, 204);
    });
}
