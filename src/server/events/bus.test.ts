import { expect, test, vi } from "vitest";
import { type ActivityEvent, createEventBus } from "./bus.js";

const event: ActivityEvent = {
  id: "e1",
  seq: 1,
  actorId: "a1",
  subjectType: "product",
  subjectId: "p1",
  productId: "p1",
  projectId: null,
  action: "product.created",
  payload: { name: "trail" },
  createdAt: new Date(0),
};

test("a subscriber receives each published event until it unsubscribes", () => {
  const bus = createEventBus();
  const seen: string[] = [];
  const unsubscribe = bus.subscribe((e) => seen.push(e.id));
  bus.publish(event);
  unsubscribe();
  bus.publish({ ...event, id: "e2" });
  expect(seen).toEqual(["e1"]);
});

test("a throwing subscriber does not stop publish or the others", () => {
  const bus = createEventBus();
  const seen: string[] = [];
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe((e) => seen.push(e.id));
  expect(() => bus.publish(event)).not.toThrow();
  expect(seen).toEqual(["e1"]);
});

test("an actor subscriber receives each actor update until it unsubscribes, and no activity event", () => {
  const bus = createEventBus();
  const actors: unknown[] = [];
  const events: string[] = [];
  bus.subscribe((e) => events.push(e.id));
  const unsubscribe = bus.subscribeActors((u) => actors.push(u));
  bus.publishActor({
    actorId: "a1",
    photoUrl: "/api/photos/a1/h",
    title: null,
  });
  unsubscribe();
  bus.publishActor({ actorId: "a1", photoUrl: null, title: null });
  expect(actors).toEqual([
    { actorId: "a1", photoUrl: "/api/photos/a1/h", title: null },
  ]);
  expect(events).toEqual([]);
});

test("a throwing actor subscriber does not stop publishActor or the others", () => {
  const bus = createEventBus();
  const seen: (string | null)[] = [];
  bus.subscribeActors(() => {
    throw new Error("boom");
  });
  bus.subscribeActors((u) => seen.push(u.photoUrl));
  expect(() =>
    bus.publishActor({ actorId: "a1", photoUrl: null, title: null }),
  ).not.toThrow();
  expect(seen).toEqual([null]);
});

test("an access subscriber receives each access notice until it unsubscribes, and nothing else", () => {
  const bus = createEventBus();
  const access: unknown[] = [];
  const events: string[] = [];
  const actors: unknown[] = [];
  bus.subscribe((e) => events.push(e.id));
  bus.subscribeActors((u) => actors.push(u));
  const unsubscribe = bus.subscribeAccess((n) => access.push(n));
  bus.publishAccess({ githubId: 7, email: null });
  bus.publish(event);
  bus.publishActor({ actorId: "a1", photoUrl: null, title: null });
  unsubscribe();
  bus.publishAccess({ githubId: null, email: "a@b.c" });
  expect(access).toEqual([{ githubId: 7, email: null }]);
  expect(events).toEqual(["e1"]);
  expect(actors).toHaveLength(1);
});

test("an access notice never reaches event, actor or message subscribers", () => {
  const bus = createEventBus();
  const seen: string[] = [];
  bus.subscribe(() => seen.push("event"));
  bus.subscribeActors(() => seen.push("actor"));
  bus.subscribeMessages(() => seen.push("message"));
  bus.publishAccess({ githubId: 7, email: null });
  expect(seen).toEqual([]);
});

test("a throwing access subscriber does not stop publishAccess or the others", () => {
  const bus = createEventBus();
  const seen: (string | null)[] = [];
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  bus.subscribeAccess(() => {
    throw new Error("boom");
  });
  bus.subscribeAccess((n) => seen.push(n.email));
  expect(() =>
    bus.publishAccess({ githubId: null, email: "a@b.c" }),
  ).not.toThrow();
  expect(seen).toEqual(["a@b.c"]);
  expect(logged).toHaveBeenCalledOnce();
  logged.mockRestore();
});
