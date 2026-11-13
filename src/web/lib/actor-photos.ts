import type { QueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/queries";

/**
 * The `/events` stream's `actor` event: an actor's photo or a bot's title changed. It
 * carries both as they are now, so the latest one is the actor's whole state.
 */
export type ActorUpdate = {
  actorId: string;
  photoUrl: string | null;
  title: string | null;
};

/**
 * `value` with every actor view whose `id` is `update.actorId` carrying the update's
 * `photoUrl` and `title`. An actor view is an object with a `photoUrl` of its own: an
 * issue has an `id` and a `title` too, and must keep its title. What nothing changed
 * under comes back as the same reference, so react-query and React skip it.
 */
export function withActorUpdate<T>(value: T, update: ActorUpdate): T {
  if (Array.isArray(value)) {
    let next: unknown[] | null = null;
    value.forEach((item, i) => {
      const updated = withActorUpdate(item, update);
      if (updated !== item) {
        next ??= [...value];
        next[i] = updated;
      }
    });
    return (next ?? value) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  if (record.id === update.actorId && Object.hasOwn(record, "photoUrl")) {
    if (record.photoUrl !== update.photoUrl) {
      next = { ...record, photoUrl: update.photoUrl };
    }
    if (Object.hasOwn(record, "title") && record.title !== update.title) {
      next = { ...(next ?? record), title: update.title };
    }
  }
  for (const [key, item] of Object.entries(record)) {
    const updated = withActorUpdate(item, update);
    if (updated !== item) {
      next ??= { ...record };
      next[key] = updated;
    }
  }
  return (next ?? value) as T;
}

/**
 * Puts the new photo and title into every cached read that names the actor. People rows
 * carry no actor id, so the people list is read again instead.
 */
export function applyActorUpdate(
  queryClient: QueryClient,
  update: ActorUpdate,
) {
  // annotated: an updater over `unknown` data collapses into `unknown` and loses its context
  queryClient.setQueriesData<unknown>({}, (data: unknown) => {
    const next = withActorUpdate(data, update);
    // undefined skips the query: setting the same data would still mark it fresh
    return next === data ? undefined : next;
  });
  void queryClient.invalidateQueries({ queryKey: keys.people });
}
