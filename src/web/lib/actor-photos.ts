import type { QueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/queries";

/** The `/events` stream's `actor` event: an actor's photo changed or was removed. */
export type ActorUpdate = { actorId: string; photoUrl: string | null };

/**
 * `value` with every object whose `id` is `actorId` and which has a `photoUrl` of its own
 * carrying `photoUrl` instead. What nothing changed under comes back as the same reference,
 * so react-query and React skip it.
 */
export function withActorPhoto<T>(
  value: T,
  actorId: string,
  photoUrl: string | null,
): T {
  if (Array.isArray(value)) {
    let next: unknown[] | null = null;
    value.forEach((item, i) => {
      const updated = withActorPhoto(item, actorId, photoUrl);
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
  if (
    record.id === actorId &&
    Object.hasOwn(record, "photoUrl") &&
    record.photoUrl !== photoUrl
  ) {
    next = { ...record, photoUrl };
  }
  for (const [key, item] of Object.entries(record)) {
    const updated = withActorPhoto(item, actorId, photoUrl);
    if (updated !== item) {
      next ??= { ...record };
      next[key] = updated;
    }
  }
  return (next ?? value) as T;
}

/**
 * Puts the new photo into every cached read that names the actor. People rows carry no
 * actor id, so the people list is read again instead.
 */
export function applyActorUpdate(
  queryClient: QueryClient,
  { actorId, photoUrl }: ActorUpdate,
) {
  // annotated: an updater over `unknown` data collapses into `unknown` and loses its context
  queryClient.setQueriesData<unknown>({}, (data: unknown) => {
    const next = withActorPhoto(data, actorId, photoUrl);
    // undefined skips the query: setting the same data would still mark it fresh
    return next === data ? undefined : next;
  });
  void queryClient.invalidateQueries({ queryKey: keys.people });
}
