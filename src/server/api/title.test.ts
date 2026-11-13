import { expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { setActorPhoto } from "../service/photos.js";
import { BOT_TITLE_MAX } from "../service/validate.js";
import { setupTestApp } from "../test-app.js";
import { PNG } from "../test-images.js";

const {
  app,
  db,
  bot,
  bus,
  published,
  request,
  addBot,
  addProject,
  owner,
  signIn,
} = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

const putTitle = (json: unknown, key: string = bot.key) =>
  request("PUT", "/api/v1/me/title", { key, json });

const whoami = async (key: string = bot.key) =>
  (await (await request("GET", "/api/v1/whoami", { key })).json()) as Body;

test("a bot sets its title, trimmed, and whoami returns it", async () => {
  const res = await putTitle({ title: "  Release manager \n" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ title: "Release manager" });
  expect((await whoami()).title).toBe("Release manager");
});

test("clearing the title leaves none, and clearing again succeeds", async () => {
  const mine = addBot("clearer");
  await putTitle({ title: "Triage" }, mine.key);
  for (let i = 0; i < 2; i++) {
    const res = await request("DELETE", "/api/v1/me/title", { key: mine.key });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: null });
  }
  expect((await whoami(mine.key)).title).toBeNull();
});

test("a title of 40 characters after trimming is kept; 41, blank or whitespace is a 422 that changes nothing", async () => {
  const mine = addBot("lengths");
  const forty = "x".repeat(40);
  const ok = await putTitle({ title: `  ${forty}\t` }, mine.key);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ title: forty });
  for (const title of ["y".repeat(41), "", "   ", "\n\t "]) {
    const res = await putTitle({ title }, mine.key);
    expect(res.status).toBe(422);
    expect(((await res.json()) as Body).error.code).toBe("validation_failed");
  }
  expect((await whoami(mine.key)).title).toBe(forty);
});

test("a title with a control or bidi character, or of invisible characters alone, is a 422 that changes nothing", async () => {
  const mine = addBot("hidden-chars");
  await putTitle({ title: "Kept" }, mine.key);
  for (const title of [
    "\u0000ab",
    "Release\u0000manager",
    "Release\nmanager",
    "Release\tmanager",
    "On\u2028call",
    "\u202Eregenam esaeleR",
    "Ops \u2066lead\u2069",
    "\u200B",
    "\u200C\u200D\u2060",
    "\uFEFF\u200B",
  ]) {
    const res = await putTitle({ title }, mine.key);
    expect(res.status, JSON.stringify(title)).toBe(422);
    expect(((await res.json()) as Body).error.code).toBe("validation_failed");
  }
  expect((await whoami(mine.key)).title).toBe("Kept");
});

test("accented letters and emoji, joined sequences included, are a title", async () => {
  const mine = addBot("plain-chars");
  for (const title of [
    "Équipe déploiement",
    "On call 🚒",
    "Family 👩\u200D👩\u200D👧",
  ]) {
    const res = await putTitle({ title }, mine.key);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title });
  }
});

test("the database's title CHECK allows exactly BOT_TITLE_MAX, so neither bound moves alone", () => {
  const { sql } = db.$client
    .prepare(
      "select sql from sqlite_master where type = 'table' and name = 'actor'",
    )
    .get() as { sql: string };
  const bound = /length\("title"\) between 1 and (\d+)/.exec(sql)?.[1];
  expect(Number(bound)).toBe(BOT_TITLE_MAX);
});

test("an unknown key, a missing or non-string title, or a form body is refused and changes nothing", async () => {
  const mine = addBot("shapes");
  await putTitle({ title: "Kept" }, mine.key);
  for (const json of [{ title: "New", extra: 1 }, {}, { title: 7 }]) {
    expect((await putTitle(json, mine.key)).status).toBe(422);
  }
  const form = await app.request("/api/v1/me/title", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${mine.key}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "title=Form",
  });
  expect(form.status).toBe(415);
  expect((await whoami(mine.key)).title).toBe("Kept");
});

test("a key limited to reading one project sets and clears its own title, and another bot's stays", async () => {
  const other = addBot("bystander");
  await putTitle({ title: "Bystander" }, other.key);
  const scoped = createBot(db, "scoped-titler", {
    scope: { projects: [addProject("TitleScope").key], actions: ["read"] },
  });
  expect((await putTitle({ title: "Reader" }, scoped.key)).status).toBe(200);
  expect((await whoami(scoped.key)).title).toBe("Reader");
  const cleared = await request("DELETE", "/api/v1/me/title", {
    key: scoped.key,
  });
  expect(cleared.status).toBe(200);
  expect((await whoami(scoped.key)).title).toBeNull();
  expect((await whoami(other.key)).title).toBe("Bystander");
});

test("without a valid key, setting and clearing a title are 401s", async () => {
  for (const key of [null, "trail_00000000_nope"]) {
    expect((await putTitle({ title: "Anyone" }, key as string)).status).toBe(
      401,
    );
    const del = await request("DELETE", "/api/v1/me/title", {
      key: key as string,
    });
    expect(del.status).toBe(401);
  }
});

test("a signed-in person cannot set or clear a title", async () => {
  const mine = addBot("person-proof");
  await putTitle({ title: "Kept" }, mine.key);
  const cookie = await signIn(owner);
  const set = await request("PUT", "/api/v1/me/title", {
    key: null,
    cookie,
    json: { title: "Hijacked" },
  });
  expect(set.status).toBe(401);
  const clear = await request("DELETE", "/api/v1/me/title", {
    key: null,
    cookie,
  });
  expect(clear.status).toBe(401);
  expect((await whoami(mine.key)).title).toBe("Kept");
});

test("a title change publishes the bot's photo and title live, never as activity; an unchanged one publishes nothing", async () => {
  const live = addBot("live-title");
  const { photoUrl } = setActorPhoto(db, live.actor.id, PNG);
  const updates: unknown[] = [];
  const unsubscribe = bus.subscribeActors((update) => updates.push(update));
  const activityBefore = published.length;
  try {
    await putTitle({ title: "On call" }, live.key);
    await putTitle({ title: " On call " }, live.key);
    await putTitle({ title: "Off call" }, live.key);
    await request("DELETE", "/api/v1/me/title", { key: live.key });
    await request("DELETE", "/api/v1/me/title", { key: live.key });
    expect(updates).toEqual([
      { actorId: live.actor.id, photoUrl, title: "On call" },
      { actorId: live.actor.id, photoUrl, title: "Off call" },
      { actorId: live.actor.id, photoUrl, title: null },
    ]);
    expect(published.length).toBe(activityBefore);
  } finally {
    unsubscribe();
  }
});

test("a photo change publishes the bot's current title with it", async () => {
  const live = addBot("photo-keeps-title");
  await putTitle({ title: "Pictured" }, live.key);
  const updates: unknown[] = [];
  const unsubscribe = bus.subscribeActors((update) => updates.push(update));
  try {
    const { photoUrl } = (await (
      await app.request("/api/v1/me/photo", {
        method: "PUT",
        headers: { authorization: `Bearer ${live.key}` },
        body: PNG,
      })
    ).json()) as Body;
    expect(updates).toEqual([
      { actorId: live.actor.id, photoUrl, title: "Pictured" },
    ]);
  } finally {
    unsubscribe();
  }
});

test("the spec documents both title operations", async () => {
  const spec = (await (
    await app.request("/api/v1/openapi.json")
  ).json()) as Body;
  const path = spec.paths["/me/title"];
  expect(Object.keys(path).sort()).toEqual(["delete", "put"]);
  expect(path.put.responses).toHaveProperty("422");
  expect(spec.components.schemas.Bot.properties).toHaveProperty("title");
  // Whoami extends Actor, so its own properties sit in an allOf
  expect(JSON.stringify(spec.components.schemas.Whoami)).toContain('"title"');
});

test("GET /bots carries each bot's title, null without one", async () => {
  const titled = addBot("listed-titled");
  const plain = addBot("listed-plain");
  await putTitle({ title: "Listed" }, titled.key);
  const { items } = (await (
    await request("GET", "/api/v1/bots?limit=200")
  ).json()) as Body;
  const titleOf = (id: string) => items.find((b: Body) => b.id === id)?.title;
  expect(titleOf(titled.actor.id)).toBe("Listed");
  expect(titleOf(plain.actor.id)).toBeNull();
});
