import { focusManager } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { type HttpHandler, HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  WebActorView,
  WebProductRefView,
  WebWorkingNowView,
} from "@/lib/api-types";
import {
  RECONNECT_MS,
  WORK_SETTLE_MS,
  WORK_WAIT_MAX_MS,
} from "@/lib/use-live-feed";
import {
  meView,
  notFound,
  renderApp,
  serveFeed,
  serveInProgress,
  signedInAs,
} from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import {
  allProducts,
  alpha,
  beta,
  commentEntry,
  issue,
  itemCreatedEntry,
  statusEntry,
} from "@/test/fixtures";
import { server } from "@/test/server";
import { reading, watchFor } from "@/test/watch-for";

type WorkingNowEntry = WebWorkingNowView["entries"][number];

const working = (key: string, bot: WebActorView): WorkingNowEntry => ({
  item: { key, title: "Read the queue" },
  productKey: key.split("-")[0] ?? key,
  bot,
});

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

/** The feed at `/` with `entries` at work and `handlers` in front, once its first row is on screen. */
async function openFeed(
  entries: WorkingNowEntry[] = [],
  ...handlers: HttpHandler[]
) {
  signedInAs("member");
  serveInProgress(entries);
  server.use(...handlers);
  serveFeed([statusEntry("e1", minutesAgo(5))]);
  const app = renderApp("/");
  await waitFor(() =>
    expect(document.querySelector('[data-entry-id="e1"]')).not.toBeNull(),
  );
  return app;
}

/**
 * Answers Working now's read with whatever `at.entries` holds when the request lands,
 * counting each read from here on.
 */
function serveChanging(at: { entries: WorkingNowEntry[] }) {
  const reads = { count: 0 };
  server.use(
    http.get("/api/web/working-now", () => {
      reads.count += 1;
      return HttpResponse.json({
        total: at.entries.length,
        entries: at.entries,
      } satisfies WebWorkingNowView);
    }),
  );
  return reads;
}

/** The feed settled with its stream open; Working now answers from `at` and counts reads from then. */
async function openStream(at: { entries: WorkingNowEntry[] }) {
  const { queryClient, router } = await openFeed(at.entries);
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  const reads = serveChanging(at);
  FakeEventSource.current.open();
  return { queryClient, router, stream: FakeEventSource.current, reads };
}

/** Fakes only the timeouts the debounce and the reconnect wait on. */
const fakeTimers = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

/** Lets in-flight requests land without moving the faked timeouts: setImmediate is left real. */
const flushRequests = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  });

const work = (productKey: string) => JSON.stringify({ productKey });

/**
 * Query hands results to the screen on a zero-delay timeout, which a faked clock holds and
 * `useRealTimers` drops: run those before going back to real time.
 */
const landFakedNotifications = () => {
  act(() => vi.advanceTimersByTime(0));
  vi.useRealTimers();
};

afterEach(() => {
  vi.useRealTimers();
});

const strip = () => screen.queryByRole("region", { name: "Working now" });

const stripKey = async (key: string) =>
  within(await screen.findByRole("region", { name: "Working now" })).getByText(
    key,
  );

describe("working now", () => {
  test("the strip shows each bot's item from the one read", async () => {
    await openFeed([working("TRL-5", alpha), working("DOC-2", beta)]);
    const region = await screen.findByRole("region", { name: "Working now" });
    expect(within(region).getByText("TRL-5")).toBeInTheDocument();
    expect(within(region).getByText("DOC-2")).toBeInTheDocument();
  });

  test("two work events in quick succession read once, after the last, and the strip ends right", async () => {
    const at = { entries: [] as WorkingNowEntry[] };
    const { queryClient, stream, reads } = await openStream(at);
    fakeTimers();
    at.entries = [working("TRL-5", alpha)];
    stream.work(work("TRL"));
    act(() => vi.advanceTimersByTime(200));
    at.entries = [working("TRL-5", alpha), working("TRL-6", beta)];
    stream.work(work("TRL"));
    // a literal second: the settle is the product's promise, not a value to track
    act(() => vi.advanceTimersByTime(999));
    // a read fires the moment the timer does; the request lands after the flush
    expect(queryClient.isFetching()).toBe(0);
    await flushRequests();
    expect(reads.count).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    vi.useRealTimers();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.count).toBe(1);
    expect(await stripKey("TRL-6")).toBeInTheDocument();
  });

  test("work events every half second read every 3 s from the first unserved one, then once a second after the last", async () => {
    const { stream, reads } = await openStream({ entries: [] });
    fakeTimers();
    // the clock in ms, and the reads in by then
    const readsAt = new Map<number, number>();
    for (let at = 0; at < 10_000; at += 500) {
      stream.work(work("TRL"));
      act(() => vi.advanceTimersByTime(500));
      await flushRequests();
      readsAt.set(at + 500, reads.count);
    }
    // literal seconds: the settle and the cap are the product's promise
    expect(readsAt.get(2500)).toBe(0);
    expect(readsAt.get(3000)).toBe(1);
    expect(readsAt.get(5500)).toBe(1);
    expect(readsAt.get(6000)).toBe(2);
    expect(readsAt.get(8500)).toBe(2);
    expect(readsAt.get(9000)).toBe(3);
    expect(readsAt.get(10_000)).toBe(3);
    // the last event went out at 9.5 s
    act(() => vi.advanceTimersByTime(499));
    await flushRequests();
    expect(reads.count).toBe(3);
    act(() => vi.advanceTimersByTime(1));
    await flushRequests();
    expect(reads.count).toBe(4);
    act(() => vi.advanceTimersByTime(5000));
    await flushRequests();
    expect(reads.count).toBe(4);
  });

  test("a single work event reads once, a second later", async () => {
    const { stream, reads } = await openStream({ entries: [] });
    fakeTimers();
    stream.work(work("TRL"));
    act(() => vi.advanceTimersByTime(999));
    await flushRequests();
    expect(reads.count).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    await flushRequests();
    expect(reads.count).toBe(1);
    act(() => vi.advanceTimersByTime(5000));
    await flushRequests();
    expect(reads.count).toBe(1);
  });

  test("nothing shows while no bot has an item in progress", async () => {
    const { queryClient } = await openFeed();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(strip()).toBeNull();
  });

  test("a failed read leaves the strip out and the feed in place", async () => {
    const { queryClient } = await openFeed(
      [],
      http.get("/api/web/working-now", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "Broken" } },
          { status: 500 },
        ),
      ),
    );
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(strip()).toBeNull();
    expect(document.querySelector('[data-entry-id="e1"]')).not.toBeNull();
  });

  test("a reset event reads again at once", async () => {
    const at = { entries: [] as WorkingNowEntry[] };
    const { reads, stream } = await openStream(at);
    at.entries = [working("TRL-5", alpha)];
    stream.reset();
    expect(await stripKey("TRL-5")).toBeInTheDocument();
    expect(reads.count).toBe(1);
  });

  test("a reset clears a read that waits: one read, not a second at the settle or the cap", async () => {
    const at = { entries: [] as WorkingNowEntry[] };
    const { stream, reads } = await openStream(at);
    fakeTimers();
    at.entries = [working("TRL-5", alpha)];
    stream.work(work("TRL"));
    stream.reset();
    await flushRequests();
    expect(reads.count).toBe(1);
    act(() => vi.advanceTimersByTime(WORK_WAIT_MAX_MS));
    await flushRequests();
    expect(reads.count).toBe(1);
  });

  test("leaving the feed drops a read that waits, and closes the stream", async () => {
    const { queryClient, stream } = await openStream({ entries: [] });
    fakeTimers();
    const invalidated = vi.spyOn(queryClient, "invalidateQueries");
    stream.work(work("TRL"));
    cleanup();
    expect(stream.readyState).toBe(FakeEventSource.CLOSED);
    act(() => vi.advanceTimersByTime(WORK_WAIT_MAX_MS));
    await flushRequests();
    expect(invalidated).not.toHaveBeenCalled();
  });

  test("a stream reopened after a drop reads again, since work events are never replayed", async () => {
    const at = { entries: [] as WorkingNowEntry[] };
    const { stream, reads } = await openStream(at);
    fakeTimers();
    stream.fail({ closed: true });
    act(() => vi.advanceTimersByTime(RECONNECT_MS));
    vi.useRealTimers();
    at.entries = [working("TRL-5", alpha)];
    FakeEventSource.current.open();
    expect(await stripKey("TRL-5")).toBeInTheDocument();
    expect(reads.count).toBe(1);
  });

  test("a first stream that closes before opening reads again on the retry", async () => {
    const at = { entries: [] as WorkingNowEntry[] };
    const { queryClient } = await openFeed(at.entries);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    const reads = serveChanging(at);
    fakeTimers();
    FakeEventSource.current.fail({ closed: true });
    act(() => vi.advanceTimersByTime(RECONNECT_MS));
    vi.useRealTimers();
    at.entries = [working("TRL-5", alpha)];
    FakeEventSource.current.open();
    expect(await stripKey("TRL-5")).toBeInTheDocument();
    expect(reads.count).toBe(1);
  });

  test("a product granted while the feed is open reads again, once", async () => {
    const at = { entries: [] as WorkingNowEntry[] };
    const { queryClient, reads } = await openStream(at);
    server.use(
      http.get("/api/web/me", () =>
        HttpResponse.json({
          ...meView("member"),
          products: [...allProducts, { key: "ATL", name: "Atlas" }],
        }),
      ),
    );
    at.entries = [working("ATL-1", alpha)];
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    focusManager.setFocused(undefined);
    expect(await stripKey("ATL-1")).toBeInTheDocument();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.count).toBe(1);
  });

  test("entries over the stream read nothing: the work event beside them does", async () => {
    const { queryClient, stream, reads } = await openStream({ entries: [] });
    fakeTimers();
    stream.send(itemCreatedEntry("e2", minutesAgo(0)));
    stream.send(statusEntry("e3", minutesAgo(0)));
    stream.send(commentEntry("e4", minutesAgo(0)));
    act(() => vi.advanceTimersByTime(WORK_SETTLE_MS));
    vi.useRealTimers();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.count).toBe(0);
  });

  test("a filter change while a read waits still reads, once", async () => {
    const at = { entries: [] as WorkingNowEntry[] };
    const { router, stream, reads } = await openStream(at);
    fakeTimers();
    at.entries = [working("TRL-5", alpha)];
    stream.work(work("TRL"));
    await act(() => router.navigate({ to: "/", search: { product: "TRL" } }));
    act(() => vi.advanceTimersByTime(WORK_SETTLE_MS));
    vi.useRealTimers();
    expect(await stripKey("TRL-5")).toBeInTheDocument();
    expect(reads.count).toBe(1);
  });

  test("window focus reads nothing again: the stream keeps the strip current", async () => {
    const { queryClient, reads } = await openStream({ entries: [] });
    // the client refetches on focus a microtask later, so the act awaits it
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    focusManager.setFocused(undefined);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.count).toBe(0);
  });
});

const alphaProduct = { key: "ALP", name: "alpha" };
const betaProduct = { key: "BET", name: "beta" };

/** What the server answers for the viewer's access, read when each request lands. */
type Access = { products: WebProductRefView[]; entries: WorkingNowEntry[] };

/** The server's `access` event: the viewer's product access changed. No id, never replayed. */
const sendAccess = (stream: FakeEventSource) =>
  act(() => {
    stream.dispatchEvent(new MessageEvent("access", { data: "{}" }));
  });

/** The feed with its stream open, `/me` and Working now answering from `at`, each read counted. */
async function openWithAccess(at: Access) {
  const reads = { me: 0, workingNow: 0 };
  const { queryClient } = await openFeed(
    at.entries,
    http.get("/api/web/me", () => {
      reads.me += 1;
      return HttpResponse.json({
        ...meView("member"),
        products: at.products,
        ownerName: "Olive Owner",
      });
    }),
    http.get("/api/web/working-now", () => {
      reads.workingNow += 1;
      return HttpResponse.json({
        total: at.entries.length,
        entries: at.entries,
      } satisfies WebWorkingNowView);
    }),
  );
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  FakeEventSource.current.open();
  return { queryClient, reads, stream: FakeEventSource.current };
}

const productLink = (name: RegExp) =>
  within(screen.getByRole("navigation", { name: "Products" })).queryByRole(
    "link",
    { name },
  );

describe("an access event", () => {
  test("a product granted: /me and Working now read at once, and both show it", async () => {
    const at: Access = { products: [alphaProduct], entries: [] };
    const { queryClient, reads, stream } = await openWithAccess(at);
    expect(productLink(/beta/)).toBeNull();
    const before = { ...reads };
    fakeTimers();
    at.products = [alphaProduct, betaProduct];
    at.entries = [working("BET-1", beta)];
    sendAccess(stream);
    // no timer moved: neither read waits on a settle
    await flushRequests();
    expect(reads.me).toBeGreaterThan(before.me);
    expect(reads.workingNow).toBeGreaterThan(before.workingNow);
    landFakedNotifications();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(await stripKey("BET-1")).toBeInTheDocument();
    expect(productLink(/beta/)).toBeInTheDocument();
  });

  test("a product revoked: /me and Working now read at once, and neither shows it", async () => {
    const at: Access = {
      products: [alphaProduct, betaProduct],
      entries: [working("BET-1", beta)],
    };
    const { queryClient, reads, stream } = await openWithAccess(at);
    expect(await stripKey("BET-1")).toBeInTheDocument();
    expect(productLink(/beta/)).toBeInTheDocument();
    const before = { ...reads };
    fakeTimers();
    at.products = [alphaProduct];
    at.entries = [];
    sendAccess(stream);
    await flushRequests();
    expect(reads.me).toBeGreaterThan(before.me);
    expect(reads.workingNow).toBeGreaterThan(before.workingNow);
    landFakedNotifications();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(strip()).toBeNull();
    expect(productLink(/beta/)).toBeNull();
    expect(productLink(/alpha/)).toBeInTheDocument();
  });

  test.each([
    ["unchanged", [alphaProduct]],
    ["granted", [alphaProduct, betaProduct]],
  ])(
    "an access event with products %s reads Working now once",
    async (_, products) => {
      const at: Access = { products: [alphaProduct], entries: [] };
      const { queryClient, reads, stream } = await openWithAccess(at);
      const before = { ...reads };
      at.products = products;
      sendAccess(stream);
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(reads).toEqual({
        me: before.me + 1,
        workingNow: before.workingNow + 1,
      });
    },
  );

  test("an access event clears the read a work event was waiting to make", async () => {
    const at: Access = { products: [alphaProduct], entries: [] };
    const { reads, stream } = await openWithAccess(at);
    fakeTimers();
    stream.work(work("ALP"));
    sendAccess(stream);
    await flushRequests();
    const afterAccess = reads.workingNow;
    // past the settle and the cap: neither timer is left to read again
    act(() => vi.advanceTimersByTime(3000));
    await flushRequests();
    expect(reads.workingNow).toBe(afterAccess);
    // a work event after the access is still read: the timers are live, only cleared
    stream.work(work("ALP"));
    act(() => vi.advanceTimersByTime(1000));
    await flushRequests();
    expect(reads.workingNow).toBe(afterAccess + 1);
  });

  test("a product revoked: an issue page visited before shows none of its cached content on return", async () => {
    const title = "Team access: invite people by GitHub username";
    const at = { gone: false };
    signedInAs("member");
    server.use(
      http.get("/api/web/items/TRL-14", () =>
        at.gone ? notFound() : HttpResponse.json(issue()),
      ),
    );
    serveFeed([statusEntry("e1", minutesAgo(5))]);
    const { router, queryClient } = renderApp("/products/TRL/14");
    expect(await screen.findByText(title)).toBeInTheDocument();
    await router.navigate({ to: "/" });
    await waitFor(() =>
      expect(document.querySelector('[data-entry-id="e1"]')).not.toBeNull(),
    );
    const stream = FakeEventSource.current;
    expect(stream.url).not.toContain("only=actors");
    stream.open();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    at.gone = true;
    sendAccess(stream);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    const shown = watchFor(reading(title));
    await router.navigate({
      to: "/products/$key/$n",
      params: { key: "TRL", n: "14" },
    });
    expect(
      await screen.findByRole("heading", { name: "Page not found", level: 1 }),
    ).toBeInTheDocument();
    expect(shown()).toBe(false);
  });
});
