import { desc, eq, max } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { activityEvent, session, user } from "../db/schema.js";
import { readEventStream, setupTestApp } from "../test-app.js";
import { PNG } from "../test-images.js";

const {
  app,
  db,
  bus,
  bot,
  request,
  signIn,
  owner,
  addMember,
  addProject,
  addBot,
} = setupTestApp();

const ownerCookie = await signIn(owner);

/** Opens `/api/web/events` once it is listening: its first line says so. */
async function openStream(
  cookie: string,
  { query = "", lastEventId }: { query?: string; lastEventId?: number } = {},
) {
  const headers: Record<string, string> = { cookie };
  if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
  const res = await app.request(`/api/web/events${query}`, { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const stream = readEventStream(res);
  expect(await stream.next()).toEqual({ comment: "connected" });
  return stream;
}

const file = async (projectId: string, title: string, key?: string) => {
  const res = await request("POST", "/api/v1/issues", {
    json: { projectId, title },
    key,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string };
};

test("a member's stream delivers its projects' entries with the event's seq as id, and never a hidden project's", async () => {
  const mine = addProject("Mine");
  const hidden = addProject("Hidden");
  const stream = await openStream(await addMember("watcher", [mine.id]));

  await file(hidden.id, "secret");
  const filed = await file(mine.id, "public");

  const entry = await stream.nextEntry();
  expect(entry).toMatchObject({
    kind: "issue_created",
    project: { key: mine.key },
    issue: { key: filed.key, title: "public" },
    actor: { name: "tester", kind: "bot" },
  });
  expect(entry?.seq).toBeGreaterThan(0);
  await stream.cancel();
});

test("a pictured bot's streamed entry carries its photoUrl", async () => {
  const p = addProject("Pictured");
  const pictured = addBot("pictured");
  const put = await app.request("/api/v1/me/photo", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${pictured.key}`,
      "content-type": "image/png",
    },
    body: PNG,
  });
  expect(put.status).toBe(200);
  const { photoUrl } = (await put.json()) as { photoUrl: string };
  const stream = await openStream(ownerCookie);
  await file(p.id, "with a face", pictured.key);
  const entry = await stream.nextEntry();
  expect(entry?.actor).toMatchObject({ name: "pictured", photoUrl });
  expect(photoUrl).toMatch(/^\/api\/photos\//);
  await stream.cancel();
});

test("an event that changed several fields arrives as several entries under one id", async () => {
  const p = addProject("Multi");
  const issue = await file(p.id, "multi");
  const stream = await openStream(ownerCookie);
  await request("PATCH", `/api/v1/issues/${issue.id}`, {
    json: { status: "in_progress", priority: 1 },
  });
  const first = await stream.nextEntry();
  const second = await stream.nextEntry();
  expect([first?.kind, second?.kind]).toEqual([
    "status_changed",
    "priority_changed",
  ]);
  expect(second?.seq).toBe(first?.seq);
  await stream.cancel();
});

test("a project removed from the member mid-stream stops delivering at once, while its others still do", async () => {
  const kept = addProject("Kept");
  const dropped = addProject("Dropped");
  const stream = await openStream(
    await addMember("shifting", [kept.id, dropped.id]),
  );

  const res = await request("PUT", "/api/web/people/shifting", {
    key: null,
    cookie: ownerCookie,
    json: { projectKeys: [kept.key] },
  });
  expect(res.status).toBe(200);
  await file(dropped.id, "gone");
  await file(kept.id, "still here");

  expect(await stream.nextEntry()).toMatchObject({
    project: { key: kept.key },
    issue: { title: "still here" },
  });
  await stream.cancel();
});

test("Last-Event-ID resumes with the visible entries after it, then goes live", async () => {
  const p = addProject("Resume");
  const hidden = addProject("Elsewhere");
  const cookie = await addMember("resumer", [p.id]);
  const first = await openStream(cookie);
  await file(p.id, "seen");
  const seen = await first.nextEntry();
  await first.cancel();

  await file(p.id, "missed");
  await file(hidden.id, "never");
  const stream = await openStream(cookie, { lastEventId: seen?.seq });
  expect(await stream.nextEntry()).toMatchObject({
    issue: { title: "missed" },
  });
  await file(p.id, "live");
  expect(await stream.nextEntry()).toMatchObject({ issue: { title: "live" } });
  await stream.cancel();
});

test("the actor and project filters narrow the stream like the feed's", async () => {
  const a = addProject("FilterA");
  const b = addProject("FilterB");
  const other = addBot("other");
  const stream = await openStream(ownerCookie, {
    query: `?project=${a.key}&actor=${other.actor.id}`,
  });
  await file(b.id, "wrong project", other.key);
  await file(a.id, "wrong actor");
  await file(a.id, "right", other.key);
  expect(await stream.nextEntry()).toMatchObject({ issue: { title: "right" } });
  await stream.cancel();
});

afterEach(() => {
  vi.useRealTimers();
});

test("an idle stream sends a comment line every 15 seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stream = await openStream(ownerCookie);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await stream.next()).toEqual({ comment: "heartbeat" });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await stream.next()).toEqual({ comment: "heartbeat" });
  await stream.cancel();
});

test("a stream filtered to a quiet project still sends a comment line every 15 seconds while other projects are busy", async () => {
  const quiet = addProject("Quiet");
  const busy = addProject("Busy elsewhere");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stream = await openStream(ownerCookie, {
    query: `?project=${quiet.key}`,
  });
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(5_000);
    await file(busy.id, `busy ${i}`);
  }
  expect(await stream.next()).toEqual({ comment: "heartbeat" });
  await stream.cancel();
});

test("a member who renamed on GitHub keeps receiving its projects' entries", async () => {
  const p = addProject("Renamed");
  await addMember("before-rename", [p.id], { githubId: 8101 });
  const stream = await openStream(
    await signIn("after-rename", { githubId: 8101 }),
  );
  await file(p.id, "still mine");
  expect(await stream.nextEntry()).toMatchObject({
    issue: { title: "still mine" },
  });
  await stream.cancel();
});

const signOut = (cookie: string) =>
  request("POST", "/api/auth/sign-out", { key: null, cookie, json: {} });

test.each([
  [
    "the member signs out",
    async () => {
      const cookie = await addMember("signs-out", []);
      return { cookie, revoke: () => signOut(cookie) };
    },
  ],
  [
    "the owner signs out",
    async () => {
      const cookie = await signIn(owner);
      return { cookie, revoke: () => signOut(cookie) };
    },
  ],
  [
    "the member's invite is removed",
    async () => {
      const cookie = await addMember("uninvited", []);
      const revoke = () =>
        request("DELETE", "/api/web/people/uninvited", {
          key: null,
          cookie: ownerCookie,
        });
      return { cookie, revoke };
    },
  ],
])("the stream ends at the next heartbeat once %s", async (_, setup) => {
  const { cookie, revoke } = await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stream = await openStream(cookie);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await stream.next()).toEqual({ comment: "heartbeat" });
  expect((await revoke()).status).toBeLessThan(300);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await stream.next()).toBeNull();
});

test("a signed-out member's stream ends within 15 seconds while bots keep writing elsewhere", async () => {
  const watched = addProject("Watched");
  const busy = addProject("Busy while signed out");
  const cookie = await addMember("busy-signout", [watched.id]);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stream = await openStream(cookie);
  expect((await signOut(cookie)).status).toBeLessThan(300);
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(5_000);
    await file(busy.id, `while signed out ${i}`);
  }
  expect(await stream.next()).toBeNull();
});

test("a stream's re-check leaves its session's expiry alone, and the stream ends once the session expires", async () => {
  const cookie = await addMember("expiring", []);
  const person = db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.githubLogin, "expiring"))
    .get();
  if (!person) throw new Error("no user");
  const expiresAt = () =>
    db
      .select({ at: session.expiresAt })
      .from(session)
      .where(eq(session.userId, person.id))
      .get()?.at;
  const setExpiry = (at: Date) =>
    db
      .update(session)
      .set({ expiresAt: at })
      .where(eq(session.userId, person.id))
      .run();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const stream = await openStream(cookie);
  // within better-auth's update age of expiring, so a refreshing read would push it out
  const soon = new Date(Date.now() + 3_600_000);
  setExpiry(soon);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await stream.next()).toEqual({ comment: "heartbeat" });
  expect(expiresAt()).toEqual(soon);

  setExpiry(new Date(Date.now() - 1_000));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await stream.next()).toBeNull();
});

const newestSeq = () =>
  db
    .select({ seq: max(activityEvent.seq) })
    .from(activityEvent)
    .get()?.seq ?? 0;

test("a resume more than 500 events back gets one reset event at the newest seq instead of the replay, then live entries", async () => {
  const p = addProject("Busy");
  db.transaction((tx) => {
    for (let i = 0; i < 501; i++) {
      tx.insert(activityEvent)
        .values({
          actorId: bot.actor.id,
          subjectType: "project",
          subjectId: p.id,
          projectId: p.id,
          action: "project.created",
        })
        .run();
    }
  });
  const stream = await openStream(ownerCookie, { lastEventId: 0 });
  expect(await stream.next()).toEqual({
    event: "reset",
    id: String(newestSeq()),
    data: JSON.stringify({ reason: "too_far_behind" }),
  });
  await file(p.id, "after the reset");
  expect(await stream.nextEntry()).toMatchObject({
    issue: { title: "after the reset" },
  });
  await stream.cancel();
});

/** `count` project events written after the current newest seq, returned in order. */
const writeEvents = (projectId: string, count: number) =>
  db.transaction((tx) => {
    const rows = [];
    for (let i = 0; i < count; i++) {
      rows.push(
        tx
          .insert(activityEvent)
          .values({
            actorId: bot.actor.id,
            subjectType: "project",
            subjectId: projectId,
            projectId,
            action: "project.created",
          })
          .returning()
          .get(),
      );
    }
    return rows;
  });

test("a resume exactly 500 events back replays all 500, with no reset", async () => {
  const p = addProject("ReplayCap");
  const since = newestSeq();
  const missed = writeEvents(p.id, 500);
  const stream = await openStream(ownerCookie, { lastEventId: since });
  for (const event of missed) {
    expect(await stream.next()).toMatchObject({ id: String(event.seq) });
  }
  await file(p.id, "after the replay");
  expect(await stream.nextEntry()).toMatchObject({
    issue: { title: "after the replay" },
  });
  await stream.cancel();
});

test("a member's replay cap counts only the events it can see: 500 visible among 600 hidden replays", async () => {
  const mine = addProject("CapMine");
  const hidden = addProject("CapHidden");
  const cookie = await addMember("capped", [mine.id]);
  const since = newestSeq();
  const visible = writeEvents(mine.id, 500);
  writeEvents(hidden.id, 600);
  const stream = await openStream(cookie, { lastEventId: since });
  for (const event of visible) {
    expect(await stream.next()).toMatchObject({ id: String(event.seq) });
  }
  await file(mine.id, "live after replay");
  expect(await stream.nextEntry()).toMatchObject({
    issue: { title: "live after replay" },
  });
  await stream.cancel();
});

test("a member's replay cap resets at 501 visible events", async () => {
  const mine = addProject("CapMine501");
  const cookie = await addMember("capped-over", [mine.id]);
  const since = newestSeq();
  writeEvents(mine.id, 501);
  const stream = await openStream(cookie, { lastEventId: since });
  expect(await stream.next()).toEqual({
    event: "reset",
    id: String(newestSeq()),
    data: JSON.stringify({ reason: "too_far_behind" }),
  });
  await stream.cancel();
});

test("a client exactly 1000 events behind keeps its stream and gets every entry", async () => {
  const p = addProject("QueueCap");
  const stream = await openStream(ownerCookie);
  const events = writeEvents(p.id, 1000);
  // published in one turn, so none is written before the queue is full
  for (const event of events) bus.publish(event);
  for (const event of events) {
    expect(await stream.next()).toMatchObject({ id: String(event.seq) });
  }
  await file(p.id, "after the flood");
  expect(await stream.nextEntry()).toMatchObject({
    issue: { title: "after the flood" },
  });
  await stream.cancel();
});

test("a client that falls 1000 events behind gets a reset event and the stream ends", async () => {
  const p = addProject("Flood");
  await file(p.id, "flood");
  const event = db
    .select()
    .from(activityEvent)
    .where(eq(activityEvent.projectId, p.id))
    .orderBy(desc(activityEvent.seq))
    .get();
  if (!event) throw new Error("no event");
  const stream = await openStream(ownerCookie);
  // published in one turn, so none is written before the queue is over its cap
  for (let i = 1; i <= 1001; i++) bus.publish({ ...event, seq: event.seq + i });
  expect(await stream.next()).toEqual({
    event: "reset",
    id: String(event.seq + 1001),
    data: JSON.stringify({ reason: "too_far_behind" }),
  });
  expect(await stream.next()).toBeNull();
});

const STREAMS_PER_PERSON = 5;

test(`a person's stream past ${STREAMS_PER_PERSON} open at once is a 429, until one of theirs closes`, async () => {
  const cookie = await addMember("many-tabs", []);
  const open = [];
  for (let i = 0; i < STREAMS_PER_PERSON; i++)
    open.push(await openStream(cookie));

  const refused = await app.request("/api/web/events", { headers: { cookie } });
  expect(refused.status).toBe(429);
  expect(await refused.json()).toEqual({
    error: { code: "too_many_streams", message: expect.any(String) },
  });
  // another person's streams are counted apart
  const others = await openStream(ownerCookie);
  await others.cancel();

  await open.pop()?.cancel();
  await vi.waitFor(async () => {
    const res = await app.request("/api/web/events", { headers: { cookie } });
    expect(res.status).toBe(200);
    open.push(readEventStream(res));
  });
  for (const stream of open) await stream.cancel();
});
