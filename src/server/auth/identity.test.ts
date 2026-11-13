import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, expect, test } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import {
  actor,
  actorPhoto,
  invite,
  project,
  projectMember,
} from "../db/schema.js";
import { accessOfEmail, syncEmailActor, visibleProjects } from "./identity.js";

const dir = mkdtempSync(join(tmpdir(), "trail-identity-"));
const db = openDatabase(join(dir, "trail.db"));
migrate(db);
afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const owner = db
  .insert(actor)
  .values({ kind: "human", displayName: "Olive", githubId: 1, isOwner: true })
  .returning()
  .get();
const docs = db
  .insert(project)
  .values({ key: "DOC", name: "docs", createdBy: owner.id })
  .returning()
  .get();
db.insert(project)
  .values({ key: "TRL", name: "trail", createdBy: owner.id })
  .run();

const inviteEmail = (email: string, ...projectIds: string[]) => {
  const row = db
    .insert(invite)
    .values({ email, invitedBy: owner.id })
    .returning()
    .get();
  for (const projectId of projectIds) {
    db.insert(projectMember).values({ inviteId: row.id, projectId }).run();
  }
  return row;
};
const actorsWithEmail = (email: string) =>
  db.select().from(actor).where(eq(actor.email, email)).all();

test("a verified email with no invite is not let in, and gets no actor", () => {
  expect(syncEmailActor(db, "stranger@example.com")).toBeNull();
  expect(accessOfEmail(db, "stranger@example.com")).toBeNull();
  expect(actorsWithEmail("stranger@example.com")).toEqual([]);
});

test("an invited email gets a human actor on its first let-in, named for the part before @, with no GitHub and no photo", () => {
  const row = inviteEmail("dana.okafor@example.com", docs.id);
  const access = syncEmailActor(db, "dana.okafor@example.com");
  expect(access).toEqual({
    isOwner: false,
    inviteId: row.id,
    actor: {
      id: expect.any(String),
      displayName: "dana.okafor",
      githubId: null,
      githubLogin: null,
      email: "dana.okafor@example.com",
    },
  });
  const [stored] = actorsWithEmail("dana.okafor@example.com");
  expect(stored).toMatchObject({
    id: access?.actor.id,
    kind: "human",
    githubId: null,
    githubLogin: null,
    isOwner: false,
  });
  expect(
    db
      .select()
      .from(actorPhoto)
      .where(eq(actorPhoto.actorId, stored?.id ?? ""))
      .all(),
  ).toEqual([]);
  expect(access && visibleProjects(db, access).map((p) => p.key)).toEqual([
    "DOC",
  ]);
});

test("a later let-in and every request after it find the same actor", () => {
  inviteEmail("repeat@example.com");
  const first = syncEmailActor(db, "repeat@example.com");
  const again = syncEmailActor(db, "repeat@example.com");
  expect(again).toEqual(first);
  expect(accessOfEmail(db, "repeat@example.com")).toEqual(first);
  expect(actorsWithEmail("repeat@example.com")).toHaveLength(1);
});

test("the verified address matches its invite ignoring case and surrounding space", () => {
  inviteEmail("mixed@example.com");
  const access = syncEmailActor(db, "  Mixed@Example.COM ");
  expect(access?.actor.email).toBe("mixed@example.com");
  expect(accessOfEmail(db, "MIXED@example.com")).toEqual(access);
});

test("the lookup reads only: an invited email that has never let in has no access yet", () => {
  inviteEmail("waiting@example.com");
  expect(accessOfEmail(db, "waiting@example.com")).toBeNull();
  expect(actorsWithEmail("waiting@example.com")).toEqual([]);
});

test("removing the invite shuts the person out on the next lookup; a new invite lets the same actor back in", () => {
  const row = inviteEmail("leaver@example.com", docs.id);
  const before = syncEmailActor(db, "leaver@example.com");
  db.delete(invite).where(eq(invite.id, row.id)).run();

  expect(accessOfEmail(db, "leaver@example.com")).toBeNull();
  expect(syncEmailActor(db, "leaver@example.com")).toBeNull();
  expect(actorsWithEmail("leaver@example.com")).toHaveLength(1);

  inviteEmail("leaver@example.com");
  expect(syncEmailActor(db, "leaver@example.com")?.actor.id).toBe(
    before?.actor.id,
  );
});
