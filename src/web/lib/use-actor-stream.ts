import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { type ActorUpdate, applyActorUpdate } from "@/lib/actor-photos";
import { api } from "@/lib/api";
import { feedStreamHeld, useFeedStreamHeld } from "@/lib/feed-stream-holds";
import { keys } from "@/lib/queries";
import { RECONNECT_MS } from "@/lib/use-live-feed";

/**
 * Keeps every signed-in page's photos and bot titles current: an `only=actors` `/events`
 * stream. The feed page's own stream carries those events too, so this one stays closed
 * while a feed page holds its own.
 */
export function useActorStream() {
  const queryClient = useQueryClient();
  const feedHeld = useFeedStreamHeld();
  const [attempt, setAttempt] = useState(0);
  // `actor` events are never replayed: whatever changed between a drop and the next open
  // only a read brings back. Cleared by the open that reads it, and by the feed taking over.
  const dropped = useRef(false);
  const everOpened = useRef(false);

  const onActor = useEffectEvent((update: ActorUpdate) =>
    applyActorUpdate(queryClient, update),
  );
  const readEverything = useEffectEvent(() => {
    void queryClient.invalidateQueries();
  });
  const recheckSession = useEffectEvent(() => {
    void queryClient.invalidateQueries({ queryKey: keys.me });
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry bumps `attempt` to open a new stream
  useEffect(() => {
    // the live store as well as the render's `feedHeld`: a feed page mounting in this
    // same commit took its hold in an effect after this render
    if (feedHeld || feedStreamHeld()) {
      // the feed's stream covers from here on
      dropped.current = false;
      return;
    }
    const source = new EventSource(api.actorEventsUrl());
    let retry: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("open", () => {
      if (dropped.current) readEverything();
      // the GitHub photo refresh `/me` starts usually lands before this first open, so its
      // notice reached no stream
      else if (!everOpened.current) recheckSession();
      dropped.current = false;
      everOpened.current = true;
    });
    source.addEventListener("error", () => {
      dropped.current = true;
      recheckSession();
      if (source.readyState === EventSource.CLOSED) {
        retry = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_MS);
      }
    });
    source.addEventListener("actor", (event) => {
      onActor(JSON.parse((event as MessageEvent<string>).data) as ActorUpdate);
    });
    return () => {
      source.close();
      clearTimeout(retry);
    };
  }, [feedHeld, attempt]);
}
