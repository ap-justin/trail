import { beforeAll, expect, test } from "vitest";
import { readEventStream, setupTestApp } from "../test-app.js";
import { PNG } from "../test-images.js";

const { app, bus, request, signIn, owner, addMember, addProject, addBot } =
  setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = any;

const project = addProject("Titles");
const titled = addBot("titled");
const plain = addBot("untitled");
let ownerCookie = "";
let memberCookie = "";
let titledIssueKey = "";

const web = async (path: string, cookie: string) =>
  (await (
    await request("GET", `/api/web${path}`, { key: null, cookie })
  ).json()) as Body;

beforeAll(async () => {
  ownerCookie = await signIn(owner);
  memberCookie = await addMember("title-reader", [project.id]);
  await request("PUT", "/api/v1/me/title", {
    key: titled.key,
    json: { title: "Release manager" },
  });
  const fileIssue = async (key: string) => {
    const res = await request("POST", "/api/v1/issues", {
      key,
      json: { projectId: project.id, title: `by ${key}` },
    });
    return ((await res.json()) as Body).key as string;
  };
  titledIssueKey = await fileIssue(titled.key);
  await fileIssue(plain.key);
});

test("feed actors and the feed's bot filter carry the bot's title, null without one", async () => {
  const feed = await web("/feed", memberCookie);
  const actorOf = (id: string) =>
    feed.items.find((e: Body) => e.actor.id === id)?.actor;
  expect(actorOf(titled.actor.id)).toEqual({
    id: titled.actor.id,
    name: "titled",
    kind: "bot",
    photoUrl: null,
    title: "Release manager",
  });
  expect(actorOf(plain.actor.id).title).toBeNull();
  const filter = (id: string) =>
    feed.filters.actors.find((a: Body) => a.id === id);
  expect(filter(titled.actor.id).title).toBe("Release manager");
  expect(filter(plain.actor.id).title).toBeNull();
});

test("an issue's creator carries the bot's title, and a person's /me and new comment carry a null one", async () => {
  const issue = await web(`/issues/${titledIssueKey}`, memberCookie);
  expect(issue.creator).toMatchObject({
    id: titled.actor.id,
    title: "Release manager",
  });
  expect((await web("/me", memberCookie)).actor).toMatchObject({
    kind: "human",
    title: null,
  });
  const res = await request(
    "POST",
    `/api/web/issues/${titledIssueKey}/comments`,
    { key: null, cookie: memberCookie, json: { body: "thanks" } },
  );
  expect(res.status).toBe(201);
  expect(((await res.json()) as Body).actor).toMatchObject({
    kind: "human",
    title: null,
  });
});

/** Opens `/api/web/events?only=actors` once it is listening: its first line says so. */
async function openActorStream(cookie: string) {
  const res = await app.request("/api/web/events?only=actors", {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const stream = readEventStream(res);
  expect(await stream.next()).toEqual({ comment: "connected" });
  return stream;
}

const putTitle = (key: string, title: string) =>
  request("PUT", "/api/v1/me/title", { key, json: { title } });

const actorMessage = (
  actorId: string,
  photoUrl: string | null,
  title: string | null,
) => ({ event: "actor", data: JSON.stringify({ actorId, photoUrl, title }) });

test("a bot's title change reaches a member whose project it acts in, and not a member who can't see it", async () => {
  const strangerCookie = await addMember("title-stranger", [
    addProject("TitleElsewhere").id,
  ]);
  const seen = await openActorStream(memberCookie);
  const unseen = await openActorStream(strangerCookie);
  expect((await putTitle(titled.key, "Gatekeeper")).status).toBe(200);
  // the stranger's own event closes the check: anything queued before it would arrive first
  const strangerId = (await web("/me", strangerCookie)).actor.id;
  bus.publishActor({ actorId: strangerId, photoUrl: null, title: null });
  expect(await seen.next()).toStrictEqual(
    actorMessage(titled.actor.id, null, "Gatekeeper"),
  );
  expect(await unseen.next()).toStrictEqual(
    actorMessage(strangerId, null, null),
  );
  await seen.cancel();
  await unseen.cancel();
});

test("re-setting the same title sends nothing, and a later photo change carries the title with it", async () => {
  const keeper = addBot("title-keeper");
  expect((await putTitle(keeper.key, "Keeper")).status).toBe(200);
  const stream = await openActorStream(ownerCookie);
  expect((await putTitle(keeper.key, " Keeper ")).status).toBe(200);
  const put = await app.request("/api/v1/me/photo", {
    method: "PUT",
    headers: { authorization: `Bearer ${keeper.key}` },
    body: PNG,
  });
  const { photoUrl } = (await put.json()) as Body;
  expect(await stream.next()).toStrictEqual(
    actorMessage(keeper.actor.id, photoUrl, "Keeper"),
  );
  await request("DELETE", "/api/v1/me/title", { key: keeper.key });
  expect(await stream.next()).toStrictEqual(
    actorMessage(keeper.actor.id, photoUrl, null),
  );
  await stream.cancel();
});
