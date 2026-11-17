import { focusManager } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import { type HttpHandler, HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WebActorView, WebWorkingNowView } from "@/lib/api-types";
import { RECONNECT_MS, WORK_SETTLE_MS } from "@/lib/use-live-feed";
import { renderApp, serveFeed, serveInProgress, signedInAs } from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import {
  alpha,
  beta,
  commentEntry,
  itemCreatedEntry,
  statusEntry,
} from "@/test/fixtures";
import { server } from "@/test/server";

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

const work = (productKey: string) => JSON.stringify({ productKey });

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
    act(() => vi.advanceTimersByTime(WORK_SETTLE_MS - 1));
    expect(reads.count).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    vi.useRealTimers();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.count).toBe(1);
    expect(await stripKey("TRL-6")).toBeInTheDocument();
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
