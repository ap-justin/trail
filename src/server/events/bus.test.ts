import { expect, test } from "vitest";
import { type ActivityEvent, createEventBus } from "./bus.js";

const event: ActivityEvent = {
  id: "e1",
  seq: 1,
  actorId: "a1",
  subjectType: "project",
  subjectId: "p1",
  projectId: "p1",
  action: "project.created",
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
