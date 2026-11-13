import type { activityEvent } from "../db/schema.js";

/** A committed `activity_event` row, payload parsed. */
export type ActivityEvent = typeof activityEvent.$inferSelect;

export type Subscriber = (event: ActivityEvent) => void;

/** An actor's photo set, replaced or cleared: live-only, never an activity event. */
export type ActorUpdate = { actorId: string; photoUrl: string | null };

export type ActorSubscriber = (update: ActorUpdate) => void;

export interface EventBus {
  /** Calls every subscriber in turn; one that throws is logged and skipped. */
  publish(event: ActivityEvent): void;
  /** Returns the unsubscribe function. */
  subscribe(fn: Subscriber): () => void;
  /** Calls every actor subscriber in turn; one that throws is logged and skipped. */
  publishActor(update: ActorUpdate): void;
  /** Returns the unsubscribe function; `subscribe`'s subscribers never see actor updates. */
  subscribeActors(fn: ActorSubscriber): () => void;
}

function callEach<T>(
  subscribers: Set<(value: T) => void>,
  value: T,
  describe: string,
) {
  for (const fn of subscribers) {
    try {
      fn(value);
    } catch (error) {
      console.error(`event bus subscriber threw on ${describe}`, error);
    }
  }
}

export function createEventBus(): EventBus {
  const subscribers = new Set<Subscriber>();
  const actorSubscribers = new Set<ActorSubscriber>();
  return {
    publish(event) {
      callEach(subscribers, event, `${event.action} ${event.id}`);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    publishActor(update) {
      callEach(actorSubscribers, update, `actor ${update.actorId}`);
    },
    subscribeActors(fn) {
      actorSubscribers.add(fn);
      return () => actorSubscribers.delete(fn);
    },
  };
}
