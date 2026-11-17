import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import {
  type ActorUpdate,
  applyActorUpdate,
  withActorUpdate,
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
/**
 * How long Working now waits after a `work` event before reading again, restarted by each
 * one up to `WORK_WAIT_MAX_MS`: a claim or a short run of quick writes is one read, made
 * after the last of them landed.
 */
export const WORK_SETTLE_MS = 1000;
/**
 * The longest Working now waits from the first `work` event its last read didn't cover, so
 * a product writing more often than the settle still has its strip read.
 */
export const WORK_WAIT_MAX_MS = 3000;

/**
 * The feed filter values found naming something the viewer can no longer see. The filter
 * may have moved on while the check ran, so a caller clears only a filter still at its value.
 */
export type FilterGone = { actor?: string; product?: string; project?: string };

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
    case "actor":
      return withActorUpdate(state, action.update);
    case "clear":
      return noArrivals;
  }
}

/**
 * The feed under `filter`: the newest page from `/feed`, with entries from the
 * `/events` stream merged on top. The stream reopens when the filter changes.
 * `onFilterGone` runs when the filtered product or project turns out to be hidden or missing,
 * or the filtered bot is no longer among the feed's options, with the value that was.
 */
export function useLiveFeed(
  filter: FeedFilter,
  { onFilterGone }: { onFilterGone: (gone: FilterGone) => void },
) {
  const { actor, product, project, type } = filter;
  // rebuilt from the parts, so the effects below depend on values, not the caller's object
  const current = { actor, product, project, type };
  const queryClient = useQueryClient();
  const feed = useQuery({
    queryKey: keys.feed(current),
    queryFn: () => api.feed(current),
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
  // per hook, not per stream: a filter change mid-wait still owes Working now its read
  const workSettling = useRef<ReturnType<typeof setTimeout>>(undefined);
  // set by the first `work` event since the last read
  const workDue = useRef<ReturnType<typeof setTimeout>>(undefined);
  // once anything is held, later entries wait behind it so the order holds
  const hold = !atTop || state.pending.length > 0;

  const filterKey = `${actor}\u0000${product}\u0000${project}\u0000${type}`;
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
  // no page yet but a read already: Query had this feed cached, so `readSeen` started equal to it
  if (read && (filterChanged || read !== readSeen || state.page === null)) {
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

  /** Whether `/feed` under `filter` answers 404; read into the cache, so a filter left standing has its page. */
  const feedGone = async (filter: FeedFilter) => {
    try {
      await queryClient.fetchQuery({
        queryKey: keys.feed(filter),
        queryFn: () => api.feed(filter),
        staleTime: 0,
      });
      return false;
    } catch (error) {
      return error instanceof Error && isNotFound(error);
    }
  };

  const refetch = useEffectEvent(() => {
    void queryClient.invalidateQueries({ queryKey: keys.feed(current) });
  });
  const clearWorkWait = () => {
    clearTimeout(workSettling.current);
    clearTimeout(workDue.current);
    workDue.current = undefined;
  };
  const readWorkingNow = useEffectEvent(() => {
    clearWorkWait();
    void queryClient.invalidateQueries({ queryKey: keys.workingNow });
  });
  const onWork = useEffectEvent(() => {
    clearTimeout(workSettling.current);
    workSettling.current = setTimeout(() => readWorkingNow(), WORK_SETTLE_MS);
    workDue.current ??= setTimeout(() => readWorkingNow(), WORK_WAIT_MAX_MS);
  });
  const readEverything = useEffectEvent(() => {
    void queryClient.invalidateQueries();
  });
  // what this person may see changed, from `/me`'s products to Working now, the feed and any
  // product or project page cached; this read also serves a `work` event's waiting one
  const onAccess = useEffectEvent(() => {
    clearWorkWait();
    readEverything();
  });
  const onActor = useEffectEvent((update: ActorUpdate) => {
    dispatch({ type: "actor", update });
    applyActorUpdate(queryClient, update);
  });
  const recheckSession = useEffectEvent(() => {
    void queryClient.invalidateQueries({ queryKey: keys.me });
  });
  // the server closes a stream on a 4xx: a 404 is a filtered product or project this person lost,
  // which only /feed can say, since EventSource never exposes the status
  // `live` turns false once the stream is torn down: a check answering after the viewer left
  // the feed, or moved its filter, must not pull them back
  const readAfterClose = useEffectEvent(async (live: () => boolean) => {
    if (!(await feedGone(current)) || !live()) return;
    // with both set, the 404 doesn't say which: each alone answers for itself
    if (product !== null && project !== null) {
      const [productGone, projectGone] = await Promise.all([
        feedGone({ actor, product, project: null, type }),
        feedGone({ actor, product: null, project, type }),
      ]);
      if ((productGone || projectGone) && live()) {
        onFilterGone({
          ...(productGone && { product }),
          ...(projectGone && { project }),
        });
      }
    } else if (product !== null || project !== null) {
      onFilterGone({
        product: product ?? undefined,
        project: project ?? undefined,
      });
    }
  });

  useEffect(() => {
    const source = new EventSource(
      api.eventsUrl({ actor, product, project, type }),
    );
    let retry: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    source.addEventListener("open", () => {
      setConnection("open");
      // a new stream starts from now: read what the gap missed, photos and titles included,
      // since `actor` events are never replayed
      if (opened.current) readEverything();
      else if (attempt > 0) {
        refetch();
        readWorkingNow();
      }
      opened.current = true;
    });
    source.addEventListener("error", () => {
      setConnection("reconnecting");
      // a stream that ends can mean the session did, or this person was removed
      recheckSession();
      if (source.readyState === EventSource.CLOSED) {
        void readAfterClose(() => live);
        retry = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_MS);
      }
    });
    source.addEventListener("message", (event) => {
      onEntry(JSON.parse(event.data) as EntryView);
    });
    source.addEventListener("actor", (event) => {
      onActor(JSON.parse((event as MessageEvent<string>).data) as ActorUpdate);
    });
    // bot work started or stopped in a visible product, whatever this stream's filter
    source.addEventListener("work", () => onWork());
    source.addEventListener("access", () => onAccess());
    // the server fell too far behind to replay what this stream missed
    source.addEventListener("reset", () => {
      refetch();
      readWorkingNow();
      recheckSession();
    });
    return () => {
      live = false;
      source.close();
      clearTimeout(retry);
    };
  }, [actor, product, project, type, attempt]);

  // the options list every bot acting in a visible product, whatever the filter
  const actorOptions =
    feed.isSuccess && !loading ? feed.data.filters.actors : null;
  const goneActor =
    actor !== null &&
    actorOptions !== null &&
    !actorOptions.some((a) => a.id === actor)
      ? actor
      : null;
  const actorGone = useEffectEvent((gone: string) =>
    onFilterGone({ actor: gone }),
  );
  useEffect(() => {
    if (goneActor !== null) actorGone(goneActor);
  }, [goneActor]);

  // the shell's own stream stays closed while this one carries the actor changes
  useEffect(() => holdFeedStream(), []);

  useEffect(() => {
    const scheduled = timers.current;
    const settling = workSettling;
    const due = workDue;
    return () => {
      for (const timer of scheduled) clearTimeout(timer);
      clearTimeout(settling.current);
      clearTimeout(due.current);
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
    filters: feed.data?.filters ?? { actors: [], products: [], projects: [] },
    retry: () => void feed.refetch(),
  };
}
