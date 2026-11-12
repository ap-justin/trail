import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { api, type FeedFilter, isNotFound } from "@/lib/api";
import type { EntryView } from "@/lib/api-types";
import { statusOf } from "@/lib/loadable";
import { keys } from "@/lib/queries";

/** How long a row that arrived over the stream keeps its highlight. */
export const FRESH_MS = 2000;
/** The wait before opening a new stream once the browser has given up on one. */
export const RECONNECT_MS = 5000;

export type LiveConnection = "connecting" | "open" | "reconnecting";

type Arrivals = {
  /** Shown above the loaded page, newest first. */
  shown: EntryView[];
  /** Held while the viewer is scrolled away, newest first. */
  pending: EntryView[];
};

type ArrivalAction =
  | { type: "received"; entry: EntryView; hold: boolean }
  | { type: "show_pending"; entries: EntryView[] }
  | { type: "clear" };

const noArrivals: Arrivals = { shown: [], pending: [] };

function arrivals(state: Arrivals, action: ArrivalAction): Arrivals {
  switch (action.type) {
    case "received":
      return action.hold
        ? { ...state, pending: [action.entry, ...state.pending] }
        : { ...state, shown: [action.entry, ...state.shown] };
    case "show_pending":
      return { shown: [...action.entries, ...state.shown], pending: [] };
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
  const atTop = useRef(true);
  const received = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const filterKey = `${actor}\u0000${project}`;
  const [shownFor, setShownFor] = useState(filterKey);
  if (shownFor !== filterKey) {
    setShownFor(filterKey);
    dispatch({ type: "clear" });
    setFreshIds(new Set());
    setConnection("connecting");
    setAttempt(0);
    received.current = new Set();
  }

  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      run();
    }, ms);
    timers.current.add(timer);
  };

  const loading = feed.isPending || feed.isPlaceholderData;
  const loaded = loading ? [] : (feed.data?.items ?? []);
  const loadedIds = new Set(loaded.map((e) => e.id));
  // a read since they arrived (a reopened stream, a reset) can already list them
  const held = state.pending.filter((e) => !loadedIds.has(e.id));

  const onEntry = useEffectEvent((entry: EntryView) => {
    if (received.current.has(entry.id) || loadedIds.has(entry.id)) return;
    received.current.add(entry.id);
    // once anything is held, later entries wait behind it so the order holds
    dispatch({
      type: "received",
      entry,
      hold: !atTop.current || held.length > 0,
    });
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
      // a new stream starts from now: read what the gap missed
      if (attempt > 0) refetch();
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

  useEffect(() => {
    const scheduled = timers.current;
    return () => {
      for (const timer of scheduled) clearTimeout(timer);
    };
  }, []);

  const shownIds = new Set(state.shown.map((e) => e.id));

  return {
    status: loading ? "loading" : statusOf(feed),
    entries: [...state.shown, ...loaded.filter((e) => !shownIds.has(e.id))],
    freshIds,
    connection,
    pendingCount: held.length,
    showPending: () => dispatch({ type: "show_pending", entries: held }),
    setAtTop: (value: boolean) => {
      atTop.current = value;
    },
    filters: feed.data?.filters ?? { actors: [], projects: [] },
    retry: () => void feed.refetch(),
  };
}
