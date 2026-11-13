import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import {
  type ActorUpdate,
  applyActorUpdate,
  withActorPhoto,
} from "@/lib/actor-photos";
import { api, type FeedFilter, isNotFound } from "@/lib/api";
import type { EntryView } from "@/lib/api-types";
import { holdFeedStream } from "@/lib/feed-stream-holds";
import { statusOf } from "@/lib/loadable";
import { keys } from "@/lib/queries";

/** How long a row that arrived over the stream keeps its highlight. */
export const FRESH_MS = 2000;
/** The wait before opening a new stream once the browser has given up on one. */
export const RECONNECT_MS = 5000;

export type LiveConnection = "connecting" | "open" | "reconnecting";

type Arrivals = {
  /** The rows of the last `/feed` read that are on screen; null until the first read. */
  page: EntryView[] | null;
  /** Shown from the stream, newest first. */
  shown: EntryView[];
  /** Held while the viewer is scrolled away, newest first. */
  pending: EntryView[];
};

type ArrivalAction =
  | { type: "received"; entry: EntryView; hold: boolean }
  | { type: "read"; items: EntryView[]; hold: boolean }
  | { type: "show_pending" }
  | { type: "actor"; update: ActorUpdate }
  | { type: "clear" };

const noArrivals: Arrivals = { page: null, shown: [], pending: [] };

// a refetch after a gap brings rows newer than ones the stream already delivered;
// stable, so equal timestamps keep the order they came in
const newestFirst = (entries: EntryView[]) =>
  entries.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

const idsOf = (...lists: EntryView[][]) =>
  new Set(lists.flat().map((e) => e.id));

function arrivals(state: Arrivals, action: ArrivalAction): Arrivals {
  switch (action.type) {
    case "received":
      return action.hold
        ? { ...state, pending: [action.entry, ...state.pending] }
        : { ...state, shown: [action.entry, ...state.shown] };
    case "read": {
      if (state.page === null || !action.hold) {
        return { ...state, page: action.items };
      }
      // a read while scrolled away holds what it brings, as the stream's rows are held
      const onScreen = idsOf(state.page, state.shown);
      const heldIds = idsOf(state.pending);
      const newcomers = action.items.filter(
        (e) => !onScreen.has(e.id) && !heldIds.has(e.id),
      );
      for (const e of newcomers) heldIds.add(e.id);
      return {
        ...state,
        page: action.items.filter((e) => !heldIds.has(e.id)),
        pending: newestFirst([...state.pending, ...newcomers]),
      };
    }
    case "show_pending":
      return {
        ...state,
        shown: [...state.pending, ...state.shown],
        pending: [],
      };
    case "actor": {
      const { actorId, photoUrl } = action.update;
      return withActorPhoto(state, actorId, photoUrl);
    }
    case "clear":
      return noArrivals;
  }
}

/**
 * The feed under `filter`: the newest page from `/feed`, with entries from the
 * `/events` stream merged on top. The stream reopens when the filter changes.
 * `onProjectGone` runs when the filtered project turns out to be hidden or missing.
 */
export function useLiveFeed(
  filter: FeedFilter,
  { onProjectGone }: { onProjectGone: () => void },
) {
  const { actor, project } = filter;
  const queryClient = useQueryClient();
  const feed = useQuery({
    queryKey: keys.feed({ actor, project }),
    queryFn: () => api.feed({ actor, project }),
    // the stream keeps it current; a focus refetch would only repeat it
    refetchOnWindowFocus: false,
    // the filter options stay while another filter's page loads
    placeholderData: keepPreviousData,
  });

  const [state, dispatch] = useReducer(arrivals, noArrivals);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const [connection, setConnection] = useState<LiveConnection>("connecting");
  const [attempt, setAttempt] = useState(0);
  const [atTop, setAtTop] = useState(true);
  const received = useRef(new Set<string>());
  // set by the first open under this filter; any later open follows a gap
  const opened = useRef(false);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // once anything is held, later entries wait behind it so the order holds
  const hold = !atTop || state.pending.length > 0;

  const filterKey = `${actor}\u0000${project}`;
  const [shownFor, setShownFor] = useState(filterKey);
  const filterChanged = shownFor !== filterKey;
  if (filterChanged) {
    setShownFor(filterKey);
    dispatch({ type: "clear" });
    setFreshIds(new Set());
    setConnection("connecting");
    setAttempt(0);
    received.current = new Set();
    opened.current = false;
  }

  const loading = feed.isPending || feed.isPlaceholderData;
  const read = loading ? null : (feed.data?.items ?? null);
  const [readSeen, setReadSeen] = useState(read);
  if (read && (filterChanged || read !== readSeen)) {
    setReadSeen(read);
    dispatch({ type: "read", items: read, hold });
  }

  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, ms);
    timers.current.add(timer);
  };

  const readIds = idsOf(read ?? []);

  const onEntry = useEffectEvent((entry: EntryView) => {
    if (received.current.has(entry.id) || readIds.has(entry.id)) return;
    received.current.add(entry.id);
    dispatch({ type: "received", entry, hold });
    setFreshIds((ids) => new Set(ids).add(entry.id));
    later(FRESH_MS, () =>
      setFreshIds((ids) => {
        const next = new Set(ids);
        next.delete(entry.id);
        return next;
      }),
    );
  });

  const refetch = useEffectEvent(() => {
    void queryClient.invalidateQueries({
      queryKey: keys.feed({ actor, project }),
    });
  });
  const readEverything = useEffectEvent(() => {
    void queryClient.invalidateQueries();
  });
  const onActor = useEffectEvent((update: ActorUpdate) => {
    dispatch({ type: "actor", update });
    applyActorUpdate(queryClient, update);
  });
  const recheckSession = useEffectEvent(() => {
    void queryClient.invalidateQueries({ queryKey: keys.me });
  });
  // the server closes a stream on a 4xx: a 404 is a filtered project this person lost,
  // which only /feed can say, since EventSource never exposes the status
  const readAfterClose = useEffectEvent(async () => {
    try {
      await queryClient.fetchQuery({
        queryKey: keys.feed({ actor, project }),
        queryFn: () => api.feed({ actor, project }),
        staleTime: 0,
      });
    } catch (error) {
      if (project !== null && error instanceof Error && isNotFound(error)) {
        onProjectGone();
      }
    }
  });

  useEffect(() => {
    const source = new EventSource(api.eventsUrl({ actor, project }));
    let retry: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("open", () => {
      setConnection("open");
      // a new stream starts from now: read what the gap missed, photos included,
      // since `actor` events are never replayed
      if (opened.current) readEverything();
      else if (attempt > 0) refetch();
      opened.current = true;
    });
    source.addEventListener("error", () => {
      setConnection("reconnecting");
      // a stream that ends can mean the session did, or this person was removed
      recheckSession();
      if (source.readyState === EventSource.CLOSED) {
        void readAfterClose();
        retry = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_MS);
      }
    });
    source.addEventListener("message", (event) => {
      onEntry(JSON.parse(event.data) as EntryView);
    });
    source.addEventListener("actor", (event) => {
      onActor(JSON.parse((event as MessageEvent<string>).data) as ActorUpdate);
    });
    // the server fell too far behind to replay what this stream missed
    source.addEventListener("reset", () => {
      refetch();
      recheckSession();
    });
    return () => {
      source.close();
      clearTimeout(retry);
    };
  }, [actor, project, attempt]);

  // the shell's own stream stays closed while this one carries the photo changes
  useEffect(() => holdFeedStream(), []);

  useEffect(() => {
    const scheduled = timers.current;
    return () => {
      for (const timer of scheduled) clearTimeout(timer);
    };
  }, []);

  const shownIds = new Set(state.shown.map((e) => e.id));

  return {
    status: loading ? "loading" : statusOf(feed),
    entries: newestFirst([
      ...state.shown,
      ...(state.page ?? []).filter((e) => !shownIds.has(e.id)),
    ]),
    freshIds,
    connection,
    pendingCount: state.pending.length,
    showPending: () => dispatch({ type: "show_pending" }),
    setAtTop,
    filters: feed.data?.filters ?? { actors: [], projects: [] },
    retry: () => void feed.refetch(),
  };
}
