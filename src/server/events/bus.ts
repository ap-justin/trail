import type { activityEvent } from "../db/schema.js";

/** A committed `activity_event` row, payload parsed. */
export type ActivityEvent = typeof activityEvent.$inferSelect;

export type Subscriber = (event: ActivityEvent) => void;

export interface EventBus {
  /** Calls every subscriber in turn; one that throws is logged and skipped. */
  publish(event: ActivityEvent): void;
  /** Returns the unsubscribe function. */
  subscribe(fn: Subscriber): () => void;
}

export function createEventBus(): EventBus {
  const subscribers = new Set<Subscriber>();
  return {
    publish(event) {
      for (const fn of subscribers) {
        try {
          fn(event);
        } catch (error) {
          console.error(
            `event bus subscriber threw on ${event.action} ${event.id}`,
            error,
          );
        }
      }
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
