import { expect, test } from "vitest";
import { type ActivityEvent, createEventBus } from "./bus.js";

const event: ActivityEvent = {
  id: "e1",
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
