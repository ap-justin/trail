import { beforeAll, expect, test } from "vitest";
import { photoUrl, setActorPhoto } from "../service/photos.js";
import { setupTestApp } from "../test-app.js";
import { JPEG, OTHER_PNG, PNG } from "../test-images.js";

const { app, db, request, signIn, owner, addMember, addProject, addBot } =
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
let bareCookie = "";
let botUrl = "";
let memberUrl = "";
let plainIssueKey = "";
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
  bareCookie = await addMember("bare-person", [project.id]);
  ownerId = (await web("GET", "/me", ownerCookie)).actor.id;
  memberId = (await web("GET", "/me", memberCookie)).actor.id;
  botUrl = setActorPhoto(db, pictured.actor.id, PNG).photoUrl;
  memberUrl = setActorPhoto(db, memberId, JPEG).photoUrl;
  const fileIssue = async (key: string) => {
    const res = await request("POST", "/api/v1/issues", {
      key,
      json: { projectId: project.id, title: `by ${key}` },
    });
    return ((await res.json()) as Body).key as string;
  };
  picturedIssueKey = await fileIssue(pictured.key);
  plainIssueKey = await fileIssue(plain.key);
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
  const without = await web("GET", `/issues/${plainIssueKey}`, memberCookie);
  expect(without.creator).toMatchObject({ id: plain.actor.id, photoUrl: null });
});

test("an issue's assignee, its timeline comments, and a project's status update author carry the photo URL", async () => {
  const filed = await request("POST", "/api/v1/issues", {
    key: plain.key,
    json: {
      projectId: project.id,
      title: "assigned",
      assigneeId: pictured.actor.id,
    },
  });
  const { key } = (await filed.json()) as Body;
  await request("POST", `/api/v1/issues/${key}/comments`, {
    key: pictured.key,
    json: { body: "on it" },
  });
  await request("POST", `/api/v1/projects/${project.id}/status-updates`, {
    key: pictured.key,
    json: { body: "going well", health: "on_track" },
  });

  const issue = await web("GET", `/issues/${key}`, memberCookie);
  expect(issue.assignee).toMatchObject({
    id: pictured.actor.id,
    photoUrl: botUrl,
  });
  const comment = issue.timeline.find((e: Body) => e.kind === "comment");
  expect(comment.actor).toMatchObject({
    id: pictured.actor.id,
    photoUrl: botUrl,
  });
  const created = issue.timeline.find((e: Body) => e.kind === "issue_created");
  expect(created.actor.photoUrl).toBeNull();

  const proj = await web("GET", `/projects/${project.key}`, memberCookie);
  expect(proj.latestStatusUpdate.author).toMatchObject({
    id: pictured.actor.id,
    photoUrl: botUrl,
  });
  const rows = await web(
    "GET",
    `/projects/${project.key}/issues`,
    memberCookie,
  );
  const row = rows.items.find((i: Body) => i.key === key);
  expect(row.assignee).toMatchObject({ photoUrl: botUrl });
});

test("/me and a person's new comment carry their photo URL", async () => {
  expect((await web("GET", "/me", memberCookie)).actor.photoUrl).toBe(
    memberUrl,
  );
  expect((await web("GET", "/me", bareCookie)).actor.photoUrl).toBeNull();
  const comment = await web(
    "POST",
    `/issues/${plainIssueKey}/comments`,
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
  expect(again.items.find((p: Body) => p.username === owner)).toMatchObject({
    owner: true,
    photoUrl: ownerUrl,
  });
});

test("replacing a bot's photo, then clearing it, shows on every author view at once", async () => {
  const shifter = addBot("shifter");
  const putPhoto = async (body: Uint8Array) => {
    const res = await app.request("/api/v1/me/photo", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${shifter.key}`,
        "content-type": "image/png",
      },
      body,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as Body).photoUrl as string;
  };
  const first = await putPhoto(PNG);

  const filed = await request("POST", "/api/v1/issues", {
    key: shifter.key,
    json: { projectId: project.id, title: "shifting face" },
  });
  const { key } = (await filed.json()) as Body;
  await request("POST", `/api/v1/issues/${key}/comments`, {
    key: shifter.key,
    json: { body: "hi" },
  });
  await request("POST", `/api/v1/projects/${project.id}/status-updates`, {
    key: shifter.key,
    json: { body: "status", health: "on_track" },
  });

  const photoOnEveryView = async () => {
    const feed = await web("GET", "/feed", memberCookie);
    const issue = await web("GET", `/issues/${key}`, memberCookie);
    const proj = await web("GET", `/projects/${project.key}`, memberCookie);
    const urls = {
      feedActors: feed.items
        .filter((e: Body) => e.actor.id === shifter.actor.id)
        .map((e: Body) => e.actor.photoUrl),
      feedFilter: feed.filters.actors.find(
        (a: Body) => a.id === shifter.actor.id,
      ).photoUrl,
      creator: issue.creator.photoUrl,
      timeline: issue.timeline
        .filter((e: Body) => e.actor.id === shifter.actor.id)
        .map((e: Body) => e.actor.photoUrl),
      statusUpdate: proj.latestStatusUpdate.author.photoUrl,
    };
    return urls;
  };
  const everyViewShows = (url: string | null) => {
    const expected = (n: number) => Array(n).fill(url);
    return async () => {
      const seen = await photoOnEveryView();
      expect(seen.feedActors.length).toBeGreaterThan(0);
      expect(seen.feedActors).toEqual(expected(seen.feedActors.length));
      expect(seen.timeline.length).toBeGreaterThan(0);
      expect(seen.timeline).toEqual(expected(seen.timeline.length));
      expect(seen.feedFilter).toBe(url);
      expect(seen.creator).toBe(url);
      expect(seen.statusUpdate).toBe(url);
    };
  };

  await everyViewShows(first)();

  const second = await putPhoto(OTHER_PNG);
  expect(second).not.toBe(first);
  await everyViewShows(second)();

  const cleared = await request("DELETE", "/api/v1/me/photo", {
    key: shifter.key,
  });
  expect(cleared.status).toBe(200);
  await everyViewShows(null)();
});
