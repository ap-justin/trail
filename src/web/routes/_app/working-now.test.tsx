import { focusManager, type QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import { delay, type HttpHandler, HttpResponse, http } from "msw";
import { describe, expect, test, vi } from "vitest";
import type { EntryView, WebActorView } from "@/lib/api-types";
import { RECONNECT_MS } from "@/lib/use-live-feed";
import { renderApp, serveFeed, serveInProgress, signedInAs } from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import {
  alpha,
  beta,
  commentEntry,
  issueRow,
  itemCreatedEntry,
  itemList,
  projectImportedEntry,
  statusEntry,
  trail,
} from "@/test/fixtures";
import { server } from "@/test/server";

const olive: WebActorView = {
  id: "a-olive",
  name: "Olive Owner",
  kind: "human",
  photoUrl: null,
  title: null,
};

const inProgress = (key: string, assignee: WebActorView) =>
  issueRow({ key, title: "Read the queue", status: "in_progress", assignee });

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

/**
 * The feed at `/` with `byProduct` as each product's in-progress items and `handlers` in
 * front, once its first row is on screen.
 */
async function openFeed(
  byProduct: Parameters<typeof serveInProgress>[0] = {},
  ...handlers: HttpHandler[]
) {
  signedInAs("member");
  serveInProgress(byProduct);
  server.use(...handlers);
  serveFeed([statusEntry("e1", minutesAgo(5))]);
  const app = renderApp("/");
  await waitFor(() =>
    expect(document.querySelector('[data-entry-id="e1"]')).not.toBeNull(),
  );
  return app;
}

/** Whether the strip is on screen once every read has answered. */
async function stripOnceSettled(queryClient: QueryClient) {
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return strip();
}

const strip = () => screen.queryByRole("region", { name: "Working now" });

/** Alpha taking TRL-12 on: the entry beside the status change when a bot claims an item. */
const assigneeEntry = (id: string, createdAt: string): EntryView => ({
  kind: "assignee_changed",
  id,
  createdAt,
  actor: alpha,
  product: trail,
  project: null,
  item: { key: "TRL-12", title: "Stream the feed over SSE", type: "issue" },
  from: null,
  to: alpha,
});

/**
 * Counts the requests for TRL's in-progress items from here on; each answers with none,
 * after a wait, so an entry sent right after another lands while its read is under way.
 */
function countTrlReads() {
  const reads = { count: 0 };
  server.use(
    http.get("/api/web/products/TRL/items", async ({ request }) => {
      if (new URL(request.url).searchParams.get("status") !== "in_progress") {
        return;
      }
      reads.count += 1;
      await delay(20);
      return HttpResponse.json(itemList([]));
    }),
  );
  return reads;
}

/** The feed settled with its stream open, and TRL's in-progress reads counted from then. */
async function openStream() {
  const { queryClient } = await openFeed();
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  const reads = countTrlReads();
  FakeEventSource.current.open();
  return { queryClient, stream: FakeEventSource.current, reads };
}

describe("working now", () => {
  test("a bot's in-progress item shows on the strip by its key", async () => {
    await openFeed({ TRL: [inProgress("TRL-5", alpha)] });
    const region = await screen.findByRole("region", { name: "Working now" });
    expect(within(region).getByText("TRL-5")).toBeInTheDocument();
  });

  test("nothing shows while no bot has an item in progress", async () => {
    const { queryClient } = await openFeed();
    expect(await stripOnceSettled(queryClient)).toBeNull();
  });

  test("an item in progress with a person is not bot work", async () => {
    const { queryClient } = await openFeed({
      TRL: [inProgress("TRL-6", olive)],
    });
    expect(await stripOnceSettled(queryClient)).toBeNull();
  });

  test("a product whose read fails leaves the others' bots and the feed in place", async () => {
    const { queryClient } = await openFeed(
      { DOC: [inProgress("DOC-2", beta)] },
      http.get("/api/web/products/TRL/items", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "Broken" } },
          { status: 500 },
        ),
      ),
    );
    await stripOnceSettled(queryClient);
    const region = screen.getByRole("region", { name: "Working now" });
    expect(within(region).getByText("DOC-2")).toBeInTheDocument();
    expect(document.querySelector('[data-entry-id="e1"]')).not.toBeNull();
  });

  test("an item leaving in progress over the stream leaves the strip", async () => {
    // statusEntry moves TRL-12 from in progress to done
    await openFeed({ TRL: [inProgress("TRL-12", alpha)] });
    await screen.findByRole("region", { name: "Working now" });
    FakeEventSource.current.open();
    serveInProgress({ TRL: [] });
    act(() => FakeEventSource.current.send(statusEntry("e2", minutesAgo(0))));
    await waitFor(() => expect(strip()).toBeNull());
  });

  test.each<[string, EntryView]>([
    ["an item created", itemCreatedEntry("e2", minutesAgo(0))],
    ["a status change", statusEntry("e2", minutesAgo(0))],
    ["an assignee change", assigneeEntry("e2", minutesAgo(0))],
    [
      "an import",
      projectImportedEntry("e2", minutesAgo(0), { issues: 3, comments: 0 }),
    ],
  ])(
    "%s over the stream reads its product's in-progress items again",
    async (_, entry) => {
      const { queryClient, stream, reads } = await openStream();
      stream.send(entry);
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(reads.count).toBe(1);
    },
  );

  test("a comment over the stream reads nothing again", async () => {
    const { queryClient, stream, reads } = await openStream();
    stream.send(commentEntry("e2", minutesAgo(0)));
    expect(queryClient.isFetching()).toBe(0);
    expect(reads.count).toBe(0);
  });

  test("a reset event reads the in-progress items again", async () => {
    const { queryClient, stream, reads } = await openStream();
    stream.reset();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.count).toBe(1);
  });

  test("a work event reads that product's in-progress items again", async () => {
    const { queryClient, stream, reads } = await openStream();
    stream.work(JSON.stringify({ productKey: "TRL" }));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.count).toBe(1);
  });

  test("a work event for a product the strip doesn't read reads nothing", async () => {
    const { queryClient, stream, reads } = await openStream();
    stream.work(JSON.stringify({ productKey: "NOPE" }));
    expect(queryClient.isFetching()).toBe(0);
    expect(reads.count).toBe(0);
  });

  test.each([
    ["not JSON", "{"],
    ["no product key", "{}"],
    ["a product key that isn't a string", '{"productKey":7}'],
    ["null", "null"],
  ])("a work event with %s reads nothing", async (_, data) => {
    const { queryClient, stream, reads } = await openStream();
    // a listener that throws fails the run as an unhandled error: dispatch never rethrows it
    stream.work(data);
    expect(queryClient.isFetching()).toBe(0);
    expect(reads.count).toBe(0);
  });

  test("a work event on the stream reopened after a drop reads the product once", async () => {
    const { queryClient, stream, reads } = await openStream();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stream.fail({ closed: true });
    act(() => vi.advanceTimersByTime(RECONNECT_MS));
    vi.useRealTimers();
    const reopened = FakeEventSource.current;
    expect(reopened).not.toBe(stream);
    reopened.open();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    reads.count = 0;
    reopened.work(JSON.stringify({ productKey: "TRL" }));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.count).toBe(1);
  });

  test("window focus reads no product again: the stream keeps the strip current", async () => {
    const { queryClient, reads } = await openStream();
    // the client refetches on focus a microtask later, so the act awaits it
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    focusManager.setFocused(undefined);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.count).toBe(0);
  });

  test("a bot claiming an item reads its product once for both of the claim's entries", async () => {
    const { queryClient, stream, reads } = await openStream();
    const claimedAt = minutesAgo(0);
    stream.send(
      statusEntry("e2", claimedAt, { from: "open", to: "in_progress" }),
    );
    stream.send(assigneeEntry("e3", claimedAt));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.count).toBe(1);
  });
});
