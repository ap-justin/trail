import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  feedPage,
  notFound,
  renderApp,
  serveFeed,
  signedInAs,
} from "@/test/app";
import { FakeEventSource, installFakeEventSource } from "@/test/event-source";
import { commentEntry, statusEntry } from "@/test/fixtures";
import { server } from "@/test/server";

installFakeEventSource();
afterEach(() => {
  vi.useRealTimers();
});

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();

const rowFor = (id: string) =>
  document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);

describe("feed", () => {
  test("a member lands on the feed, loaded at the largest page with no row highlighted", async () => {
    signedInAs("member");
    const asked = serveFeed([
      commentEntry("e1", minutesAgo(1)),
      statusEntry("e2", minutesAgo(30)),
    ]);
    renderApp("/");
    await waitFor(() => expect(rowFor("e1")).not.toBeNull());
    expect(rowFor("e2")).not.toBeNull();
    expect(document.querySelector(".row-fresh")).toBeNull();
    expect(asked[0]?.get("limit")).toBe("200");
    expect(FakeEventSource.current.url).toBe("/api/web/events");
    expect(screen.getByRole("main")).toBeInTheDocument();
  });
});

async function openFeed(items = [statusEntry("e2", minutesAgo(30))]) {
  signedInAs("member");
  const asked = serveFeed(items);
  const app = renderApp("/");
  await waitFor(() => expect(rowFor(items[0]?.id ?? "")).not.toBeNull());
  const stream = FakeEventSource.current;
  stream.open();
  return { ...app, asked, stream };
}

describe("live entries", () => {
  test("an entry from the stream is highlighted on top, then loses it after 2 s", async () => {
    const { stream } = await openFeed();
    vi.useFakeTimers();
    stream.send(commentEntry("e9", minutesAgo(0)));
    expect(rowFor("e9")).toHaveClass("row-fresh");
    expect(rowFor("e2")).not.toHaveClass("row-fresh");
    const rows = [...document.querySelectorAll("[data-entry-id]")].map((row) =>
      row.getAttribute("data-entry-id"),
    );
    expect(rows).toEqual(["e9", "e2"]);
    act(() => vi.advanceTimersByTime(1999));
    expect(rowFor("e9")).toHaveClass("row-fresh");
    act(() => vi.advanceTimersByTime(1));
    expect(rowFor("e9")).not.toHaveClass("row-fresh");
  });

  test("an entry the initial load already has is not added again or highlighted", async () => {
    const { stream } = await openFeed();
    stream.send(statusEntry("e2", minutesAgo(30)));
    expect(document.querySelectorAll('[data-entry-id="e2"]')).toHaveLength(1);
    expect(rowFor("e2")).not.toHaveClass("row-fresh");
  });
});

/** Reports the list's top as in or out of view, the way the feed's IntersectionObserver would. */
function watchTop() {
  let report: IntersectionObserverCallback = () => {};
  // unstubbed after each test by installFakeEventSource
  vi.stubGlobal(
    "IntersectionObserver",
    class extends window.IntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        super(callback);
        report = callback;
      }
    },
  );
  return (inView: boolean) =>
    act(() =>
      report(
        [{ isIntersecting: inView } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
}

const order = () =>
  [...document.querySelectorAll("[data-entry-id]")].map((row) =>
    row.getAttribute("data-entry-id"),
  );

describe("scrolled away", () => {
  test("entries are held as pending and the list does not move until N new is pressed", async () => {
    const topInView = watchTop();
    const { stream } = await openFeed();
    topInView(false);
    stream.send(commentEntry("e8", minutesAgo(1)));
    stream.send(commentEntry("e9", minutesAgo(0)));
    expect(order()).toEqual(["e2"]);
    // back at the top by hand: still held, so nothing jumps in under the pointer
    topInView(true);
    stream.send(commentEntry("e10", minutesAgo(0)));
    expect(order()).toEqual(["e2"]);
    await userEvent.click(screen.getByRole("button", { name: "3 new" }));
    expect(order()).toEqual(["e10", "e9", "e8", "e2"]);
    expect(
      screen.queryByRole("button", { name: /new$/ }),
    ).not.toBeInTheDocument();
  });
});

describe("scrolled away, then read again", () => {
  test("held entries the new read already lists are no longer counted as new", async () => {
    const topInView = watchTop();
    const { stream } = await openFeed();
    topInView(false);
    const e8 = commentEntry("e8", minutesAgo(1));
    const e9 = commentEntry("e9", minutesAgo(0));
    stream.send(e8);
    stream.send(e9);
    expect(screen.getByRole("button", { name: "2 new" })).toBeInTheDocument();
    serveFeed([e9, e8, statusEntry("e2", minutesAgo(30))]);
    stream.reset();
    await waitFor(() => expect(order()).toEqual(["e9", "e8", "e2"]));
    expect(
      screen.queryByRole("button", { name: /new$/ }),
    ).not.toBeInTheDocument();
    stream.send(commentEntry("e10", minutesAgo(0)));
    await userEvent.click(screen.getByRole("button", { name: "1 new" }));
    expect(order()).toEqual(["e10", "e9", "e8", "e2"]);
  });
});

describe("connection", () => {
  test("a dropped stream shows Reconnecting and keeps the rows; open clears it", async () => {
    const { stream } = await openFeed();
    expect(screen.getAllByText("Live")).not.toHaveLength(0);
    stream.fail();
    expect(
      screen.getByText(
        "Reconnecting… new activity will appear when it's back.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(rowFor("e2")).not.toBeNull();
    stream.open();
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Live")).not.toHaveLength(0);
  });

  test("a reset event reads the feed again", async () => {
    const { stream, asked } = await openFeed();
    expect(asked).toHaveLength(1);
    stream.reset();
    await waitFor(() => expect(asked).toHaveLength(2));
  });

  test("a stream the browser gave up on reads the feed, is reopened, and reads it again", async () => {
    const { stream, asked } = await openFeed();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stream.fail({ closed: true });
    expect(FakeEventSource.opened).toHaveLength(1);
    act(() => vi.advanceTimersByTime(5000));
    expect(FakeEventSource.opened).toHaveLength(2);
    vi.useRealTimers();
    await waitFor(() => expect(asked).toHaveLength(2));
    FakeEventSource.current.open();
    await waitFor(() => expect(asked).toHaveLength(3));
  });
});

describe("a project taken away while filtered to it", () => {
  test("the closed stream reads the feed again, and its 404 clears the project filter", async () => {
    const { asked } = await openFeed();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by project" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "trail" }));
    await waitFor(() => expect(asked.at(-1)?.get("project")).toBe("TRL"));
    const filtered = FakeEventSource.current;
    expect(filtered.url).toBe("/api/web/events?project=TRL");

    server.use(
      http.get("/api/web/feed", ({ request }) => {
        const query = new URL(request.url).searchParams;
        asked.push(query);
        return query.has("project")
          ? notFound()
          : HttpResponse.json(feedPage([statusEntry("e2", minutesAgo(30))]));
      }),
    );
    filtered.fail({ closed: true });
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe("/api/web/events"),
    );
    await waitFor(() => expect(asked.at(-1)?.has("project")).toBe(false));
    expect(
      screen.getByRole("combobox", { name: "Filter by project" }),
    ).toHaveTextContent("All projects");
  });
});

describe("filters", () => {
  test("offer only what /feed returned, and a choice reopens the stream and the read with it", async () => {
    const { asked } = await openFeed();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by bot" }),
    );
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["All bots", "Kai"]);
    await userEvent.click(screen.getByRole("option", { name: "Kai" }));
    await waitFor(() => expect(asked.at(-1)?.get("actor")).toBe("a-kai"));
    expect(FakeEventSource.current.url).toBe("/api/web/events?actor=a-kai");
    expect(FakeEventSource.opened[0]?.readyState).toBe(FakeEventSource.CLOSED);
  });
});
