import { beforeAll, expect, test } from "vitest";
import { photoUrl, setActorPhoto } from "../service/photos.js";
import { setupTestApp } from "../test-app.js";
import { JPEG, PNG } from "../test-images.js";

const { db, request, signIn, owner, addMember, addProject, addBot } =
  setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = any;

const project = addProject("Pictures");
const pictured = addBot("pictured");
const plain = addBot("plain");
let ownerCookie = "";
let memberCookie = "";
let ownerId = "";
let memberId = "";
let botUrl = "";
let memberUrl = "";
let issueKey = "";
let picturedIssueKey = "";

const web = async (
  method: string,
  path: string,
  cookie: string,
  json?: unknown,
) => {
  const res = await request(method, `/api/web${path}`, {
    key: null,
    cookie,
    json,
  });
  return (await res.json()) as Body;
};

beforeAll(async () => {
  ownerCookie = await signIn(owner);
  memberCookie = await addMember("pictured-person", [project.id]);
  ownerId = (await web("GET", "/me", ownerCookie)).actor.id;
  memberId = (await web("GET", "/me", memberCookie)).actor.id;
  botUrl = setActorPhoto(db, pictured.actor.id, PNG).photoUrl;
  memberUrl = setActorPhoto(db, memberId, JPEG).photoUrl;
  for (const key of [pictured.key, plain.key]) {
    const res = await request("POST", "/api/v1/issues", {
      key,
      json: { projectId: project.id, title: `by ${key}` },
    });
    issueKey = ((await res.json()) as Body).key;
    if (key === pictured.key) picturedIssueKey = issueKey;
  }
});

test("photoUrl is the actor's id and the photo's hash", () => {
  expect(photoUrl("actor-1", "ab".repeat(32))).toBe(
    `/api/photos/actor-1/${"ab".repeat(32)}`,
  );
  expect(photoUrl("actor-1", null)).toBeNull();
});

test("feed actors and the feed's bot filter carry the photo URL, null without one", async () => {
  const feed = await web("GET", "/feed", memberCookie);
  const actorOf = (id: string) =>
    feed.items.find((e: Body) => e.actor.id === id)?.actor;
  expect(actorOf(pictured.actor.id)).toEqual({
    id: pictured.actor.id,
    name: "pictured",
    kind: "bot",
    photoUrl: botUrl,
  });
  expect(actorOf(plain.actor.id).photoUrl).toBeNull();
  const filter = (id: string) =>
    feed.filters.actors.find((a: Body) => a.id === id);
  expect(filter(pictured.actor.id).photoUrl).toBe(botUrl);
  expect(filter(plain.actor.id).photoUrl).toBeNull();
});

test("an issue's creator carries the photo URL, null without one", async () => {
  const withPhoto = await web(
    "GET",
    `/issues/${picturedIssueKey}`,
    memberCookie,
  );
  expect(withPhoto.creator).toMatchObject({
    id: pictured.actor.id,
    photoUrl: botUrl,
  });
  const without = await web("GET", `/issues/${issueKey}`, memberCookie);
  expect(without.creator).toMatchObject({ id: plain.actor.id, photoUrl: null });
});

test("/me and a person's new comment carry their photo URL", async () => {
  expect((await web("GET", "/me", memberCookie)).actor.photoUrl).toBe(
    memberUrl,
  );
  expect((await web("GET", "/me", ownerCookie)).actor.photoUrl).toBeNull();
  const comment = await web(
    "POST",
    `/issues/${issueKey}/comments`,
    memberCookie,
    { body: "hello" },
  );
  expect(comment.actor.photoUrl).toBe(memberUrl);
});

test("the people list carries each signed-in person's photo URL, null for the owner without one and a pending invite", async () => {
  await web("POST", "/people", ownerCookie, {
    username: "not-yet",
    projectKeys: [],
  });
  const { items } = await web("GET", "/people", ownerCookie);
  const row = (username: string) =>
    items.find((p: Body) => p.username === username);
  expect(row(owner).photoUrl).toBeNull();
  expect(row("pictured-person").photoUrl).toBe(memberUrl);
  expect(row("not-yet")).toMatchObject({ pending: true, photoUrl: null });

  const ownerUrl = setActorPhoto(db, ownerId, PNG).photoUrl;
  const again = await web("GET", "/people", ownerCookie);
  expect(again.items[0]).toMatchObject({ owner: true, photoUrl: ownerUrl });
});
