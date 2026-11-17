import type { activityEvent } from "../db/schema.js";

/** A committed `activity_event` row, payload parsed. */
export type ActivityEvent = typeof activityEvent.$inferSelect;

export type Subscriber = (event: ActivityEvent) => void;

/**
 * An actor's photo or title changed: both as they are now, so the latest update
 * alone is the actor's state. Live-only, never an activity event.
 */
export type ActorUpdate = {
  actorId: string;
  photoUrl: string | null;
  title: string | null;
};

export type ActorSubscriber = (update: ActorUpdate) => void;

/** A message committed: its id and recipient. Live-only; it wakes the inbox webhooks' sender. */
export type MessageNotice = { id: string; recipientId: string };

export type MessageSubscriber = (notice: MessageNotice) => void;

/**
 * The products an invite lists changed, or the invite went, named by the invite's
 * GitHub id or email; subscribers match it to a holder. Live-only; it tells that
 * person's open streams to re-read.
 */
export type AccessNotice = { githubId: number | null; email: string | null };

export type AccessSubscriber = (notice: AccessNotice) => void;

export interface EventBus {
  /** Calls every subscriber in turn; one that throws is logged and skipped. */
  publish(event: ActivityEvent): void;
  /** Returns the unsubscribe function. */
  subscribe(fn: Subscriber): () => void;
  /** Calls every actor subscriber in turn; one that throws is logged and skipped. */
  publishActor(update: ActorUpdate): void;
  /** Returns the unsubscribe function; `subscribe`'s subscribers never see actor updates. */
  subscribeActors(fn: ActorSubscriber): () => void;
  /** Calls every message subscriber in turn; one that throws is logged and skipped. */
  publishMessage(notice: MessageNotice): void;
  /** Returns the unsubscribe function; messages never reach `subscribe`'s subscribers. */
  subscribeMessages(fn: MessageSubscriber): () => void;
  /** Calls every access subscriber in turn; one that throws is logged and skipped. */
  publishAccess(notice: AccessNotice): void;
  /** Returns the unsubscribe function; access notices never reach `subscribe`'s subscribers. */
  subscribeAccess(fn: AccessSubscriber): () => void;
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
  const messageSubscribers = new Set<MessageSubscriber>();
  const accessSubscribers = new Set<AccessSubscriber>();
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
    publishMessage(notice) {
      callEach(messageSubscribers, notice, `message ${notice.id}`);
    },
    subscribeMessages(fn) {
      messageSubscribers.add(fn);
      return () => messageSubscribers.delete(fn);
    },
    publishAccess(notice) {
      callEach(
        accessSubscribers,
        notice,
        `access ${notice.githubId ?? notice.email}`,
      );
    },
    subscribeAccess(fn) {
      accessSubscribers.add(fn);
      return () => accessSubscribers.delete(fn);
    },
  };
}
