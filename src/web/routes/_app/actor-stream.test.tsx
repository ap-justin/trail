import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WebProductRefView, WebWorkingNowView } from "@/lib/api-types";
import { keys } from "@/lib/queries";
import { RECONNECT_MS } from "@/lib/use-live-feed";
import { meView, renderApp, serveFeed, serveInProgress } from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import { alpha, beta, issue, statusEntry } from "@/test/fixtures";
import { server } from "@/test/server";
import { holding, watchFor } from "@/test/watch-for";

const issueTitle = "Team access: invite people by GitHub username";
const actorsOnly = "/api/web/events?only=actors";

const liveStreams = () =>
  FakeEventSource.opened.filter((s) => s.readyState !== FakeEventSource.CLOSED);

/** Signs in a member and answers the issue page, counting each read of both. */
function serveCounted() {
  const reads = { me: 0, issue: 0 };
  serveInProgress();
  server.use(
    http.get("/api/web/me", () => {
      reads.me += 1;
      return HttpResponse.json(meView("member"));
    }),
    http.get("/api/web/items/TRL-14", () => {
      reads.issue += 1;
      return HttpResponse.json(issue());
    }),
  );
  return reads;
}

/** Long enough for a read an `open` set off to have been asked for. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function openIssue() {
  const reads = serveCounted();
  const app = renderApp("/products/TRL/14");
  expect(await screen.findByText(issueTitle)).toBeInTheDocument();
  return { ...app, reads, stream: FakeEventSource.current };
}

/** The browser gave up on the stream; the hook's retry comes after `RECONNECT_MS`. */
function closeAndRetry(stream: FakeEventSource) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  stream.fail({ closed: true });
  expect(liveStreams()).toEqual([]);
  act(() => vi.advanceTimersByTime(RECONNECT_MS));
  vi.useRealTimers();
  const retried = FakeEventSource.current;
  expect(retried).not.toBe(stream);
  return retried;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the shell's actor stream", () => {
  test("asks for actor events only", async () => {
    const { stream } = await openIssue();
    expect(stream.url).toBe(actorsOnly);
    expect(liveStreams()).toEqual([stream]);
  });

  test("its first open reads /me again and nothing else", async () => {
    const reads = serveCounted();
    const asked = serveFeed([statusEntry("e3", new Date().toISOString())]);
    const { router, queryClient } = renderApp("/");
    await waitFor(() =>
      expect(document.querySelector('[data-entry-id="e3"]')).not.toBeNull(),
    );
    await router.navigate({
      to: "/products/$key/$n",
      params: { key: "TRL", n: "14" },
    });
    expect(await screen.findByText(issueTitle)).toBeInTheDocument();
    const shell = FakeEventSource.current;
    expect(shell.url).toBe(actorsOnly);

    const before = { ...reads };
    shell.open();
    await waitFor(() => expect(reads.me).toBe(before.me + 1));
    await settle();
    expect(reads).toEqual({ ...before, me: before.me + 1 });
    expect(asked).toHaveLength(1);
    const feedQueries = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["feed"] });
    expect(feedQueries.length).toBeGreaterThan(0);
    for (const query of feedQueries) {
      expect(query.state.isInvalidated).toBe(false);
    }
  });

  test("opened on a page, it reads /me once and not the page, and an actor event reads nothing", async () => {
    const { reads, stream } = await openIssue();
    stream.open();
    await waitFor(() => expect(reads.me).toBe(2));
    stream.actor({ actorId: alpha.id, photoUrl: null, title: null });
    await settle();
    expect(reads).toEqual({ me: 2, issue: 1 });
  });

  test("closed by the browser, it retries and reads every page again once it opens", async () => {
    const { reads, stream } = await openIssue();
    stream.open();
    await waitFor(() => expect(reads.me).toBe(2));

    const retried = closeAndRetry(stream);
    expect(retried.url).toBe(actorsOnly);
    // the drop itself rechecks the session
    await waitFor(() => expect(reads.me).toBe(3));
    retried.open();
    await waitFor(() => expect(reads.issue).toBe(2));
    expect(reads.me).toBe(4);
  });

  test("a re-mount after a retry reads nothing the feed's stream covered", async () => {
    const { reads, router, stream } = await openIssue();
    stream.open();
    const retried = closeAndRetry(stream);
    retried.open();
    await waitFor(() => expect(reads.issue).toBe(2));

    serveFeed([statusEntry("e3", new Date().toISOString())]);
    await router.navigate({ to: "/" });
    await waitFor(() =>
      expect(document.querySelector('[data-entry-id="e3"]')).not.toBeNull(),
    );
    FakeEventSource.current.open();
    await router.navigate({
      to: "/products/$key/$n",
      params: { key: "TRL", n: "14" },
    });
    expect(await screen.findByText(issueTitle)).toBeInTheDocument();
    const reopened = FakeEventSource.current;
    expect(reopened.url).toBe(actorsOnly);

    await settle();
    const before = { ...reads };
    reopened.open();
    await settle();
    expect(reads).toEqual(before);
  });
});

type WorkingNowEntry = WebWorkingNowView["entries"][number];
/** What the server answers for the viewer's access, read when each request lands. */
type Access = { products: WebProductRefView[]; entries: WorkingNowEntry[] };

const alphaProduct = { key: "ALP", name: "alpha" };
const betaProduct = { key: "BET", name: "beta" };
const betaAtWork: WorkingNowEntry = {
  item: { key: "BET-1", title: "Read the queue" },
  productKey: "BET",
  bot: beta,
};

/**
 * Visits the feed, so Working now is cached, then the issue page with the shell's stream
 * open; `/me` and Working now answer from `at`, each read counted.
 */
async function openIssueWithAccess(at: Access) {
  const reads = { me: 0, workingNow: 0 };
  server.use(
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
    http.get("/api/web/items/TRL-14", () => HttpResponse.json(issue())),
  );
  serveFeed([statusEntry("e3", new Date().toISOString())]);
  const { router, queryClient } = renderApp("/");
  await waitFor(() =>
    expect(document.querySelector('[data-entry-id="e3"]')).not.toBeNull(),
  );
  await router.navigate({
    to: "/products/$key/$n",
    params: { key: "TRL", n: "14" },
  });
  expect(await screen.findByText(issueTitle)).toBeInTheDocument();
  const stream = FakeEventSource.current;
  expect(stream.url).toBe(actorsOnly);
  stream.open();
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return { router, queryClient, reads, stream };
}

/** The server's `access` event: the viewer's product access changed. No id, never replayed. */
const sendAccess = (stream: FakeEventSource) =>
  act(() => {
    stream.dispatchEvent(new MessageEvent("access", { data: "{}" }));
  });

const productLink = (name: RegExp) =>
  within(screen.getByRole("navigation", { name: "Products" })).queryByRole(
    "link",
    { name },
  );

const strip = () => screen.queryByRole("region", { name: "Working now" });

describe("an access event on the shell's actor stream", () => {
  test("a product granted: /me and Working now read at once, and both show it", async () => {
    const at: Access = { products: [alphaProduct], entries: [] };
    const { router, queryClient, reads, stream } =
      await openIssueWithAccess(at);
    expect(productLink(/beta/)).toBeNull();
    const before = { ...reads };
    at.products = [alphaProduct, betaProduct];
    at.entries = [betaAtWork];
    sendAccess(stream);
    await waitFor(() => expect(productLink(/beta/)).toBeInTheDocument());
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(reads.me).toBeGreaterThan(before.me);
    expect(reads.workingNow).toBe(before.workingNow + 1);
    expect(queryClient.getQueryData(keys.workingNow)).toEqual({
      total: 1,
      entries: [betaAtWork],
    });

    await router.navigate({ to: "/" });
    expect(
      within(
        await screen.findByRole("region", { name: "Working now" }),
      ).getByText("BET-1"),
    ).toBeInTheDocument();
  });

  test("a product revoked: /me and Working now read at once, and neither shows it", async () => {
    const at: Access = {
      products: [alphaProduct, betaProduct],
      entries: [betaAtWork],
    };
    const { router, queryClient, reads, stream } =
      await openIssueWithAccess(at);
    expect(productLink(/beta/)).toBeInTheDocument();
    const before = { ...reads };
    at.products = [alphaProduct];
    at.entries = [];
    sendAccess(stream);
    await waitFor(() => expect(productLink(/beta/)).toBeNull());
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(productLink(/alpha/)).toBeInTheDocument();
    expect(reads.me).toBeGreaterThan(before.me);
    expect(reads.workingNow).toBe(before.workingNow + 1);

    // the feed's first paint is the cached strip: a revoked product's bot must not flash on it
    const feedOpened = router.navigate({ to: "/" });
    await waitFor(() =>
      expect(document.querySelector('[data-entry-id="e3"]')).not.toBeNull(),
    );
    expect(strip()).toBeNull();
    await feedOpened;
  });

  test("a product revoked: the feed visited before shows none of its cached rows on return", async () => {
    const at: Access = {
      products: [alphaProduct, betaProduct],
      entries: [],
    };
    const { router, queryClient, stream } = await openIssueWithAccess(at);
    // e3 was the revoked product's: the server's feed no longer has it
    serveFeed([statusEntry("e4", new Date().toISOString())]);
    at.products = [alphaProduct];
    sendAccess(stream);
    await waitFor(() => expect(productLink(/beta/)).toBeNull());
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    const shown = watchFor(holding('[data-entry-id="e3"]'));
    await router.navigate({ to: "/" });
    await waitFor(() =>
      expect(document.querySelector('[data-entry-id="e4"]')).not.toBeNull(),
    );
    expect(shown()).toBe(false);
  });
});
