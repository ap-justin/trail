import { act, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RECONNECT_MS } from "@/lib/use-live-feed";
import { meView, renderApp, serveFeed } from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import { issue, kai, statusEntry } from "@/test/fixtures";
import { server } from "@/test/server";

const issueTitle = "Team access: invite people by GitHub username";
const actorsOnly = "/api/web/events?only=actors";

const liveStreams = () =>
  FakeEventSource.opened.filter((s) => s.readyState !== FakeEventSource.CLOSED);

/** Signs in a member and answers the issue page, counting each read of both. */
function serveCounted() {
  const reads = { me: 0, issue: 0 };
  server.use(
    http.get("/api/web/me", () => {
      reads.me += 1;
      return HttpResponse.json(meView("member"));
    }),
    http.get("/api/web/issues/TRL-14", () => {
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
  const app = renderApp("/issues/TRL-14");
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
    await router.navigate({ to: "/issues/$key", params: { key: "TRL-14" } });
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
    stream.actor({ actorId: kai.id, photoUrl: null });
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
    await router.navigate({ to: "/issues/$key", params: { key: "TRL-14" } });
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
