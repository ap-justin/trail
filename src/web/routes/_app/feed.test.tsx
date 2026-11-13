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
import { FakeEventSource } from "@/test/event-source";
import { commentEntry, statusEntry } from "@/test/fixtures";
import { server } from "@/test/server";

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

describe("live entries, replayed", () => {
  test("the same entry delivered twice shows once and is not highlighted again", async () => {
    const { stream } = await openFeed();
    vi.useFakeTimers();
    const e9 = commentEntry("e9", minutesAgo(0));
    stream.send(e9);
    act(() => vi.advanceTimersByTime(2000));
    expect(rowFor("e9")).not.toHaveClass("row-fresh");
    // the browser reconnects with Last-Event-ID and the server replays it
    stream.send(e9);
    expect(document.querySelectorAll('[data-entry-id="e9"]')).toHaveLength(1);
    expect(rowFor("e9")).not.toHaveClass("row-fresh");
  });
});

/** Reports the list's top as in or out of view, the way the feed's IntersectionObserver would. */
function watchTop() {
  let report: IntersectionObserverCallback = () => {};
  // unstubbed after each test by installFakeEventSource, from the setup file
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
  test("held entries a new read also lists stay held and are counted once", async () => {
    const topInView = watchTop();
    const { stream } = await openFeed();
    topInView(false);
    const e8 = commentEntry("e8", minutesAgo(2));
    const e9 = commentEntry("e9", minutesAgo(1));
    stream.send(e8);
    stream.send(e9);
    expect(screen.getByRole("button", { name: "2 new" })).toBeInTheDocument();
    serveFeed([
      commentEntry("g1", minutesAgo(0)),
      e9,
      e8,
      statusEntry("e2", minutesAgo(30)),
    ]);
    stream.reset();
    expect(
      await screen.findByRole("button", { name: "3 new" }),
    ).toBeInTheDocument();
    expect(order()).toEqual(["e2"]);
    stream.send(commentEntry("e10", minutesAgo(0)));
    await userEvent.click(screen.getByRole("button", { name: "4 new" }));
    expect(order()).toEqual(["e10", "g1", "e9", "e8", "e2"]);
  });
});

describe("the session behind a stream", () => {
  test.each([
    ["a stream error", (s: FakeEventSource) => s.fail()],
    ["a reset event", (s: FakeEventSource) => s.reset()],
  ])("%s reads /me, and a removed member leaves the feed", async (_, drop) => {
    const { stream } = await openFeed();
    signedInAs("not_invited");
    drop(stream);
    expect(
      await screen.findByRole("heading", { name: "You're not invited yet" }),
    ).toBeInTheDocument();
  });
});

describe("connection", () => {
  test("a dropped stream shows Reconnecting and keeps the rows; open clears it", async () => {
    const { stream, asked } = await openFeed();
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
    // the reopened stream reads what the gap missed; left in flight, that read lands in the next test
    await waitFor(() => expect(asked).toHaveLength(2));
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

/** Drops the stream for good and lets the retry open the next one, which then reads the feed. */
async function reconnect(stream: FakeEventSource) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  stream.fail({ closed: true });
  act(() => vi.advanceTimersByTime(5000));
  vi.useRealTimers();
  FakeEventSource.current.open();
}

describe("after a reconnect", () => {
  test("rows the gap missed sit above the older rows the stream delivered", async () => {
    const { stream } = await openFeed();
    const e8 = commentEntry("e8", minutesAgo(10));
    stream.send(e8);
    expect(order()).toEqual(["e8", "e2"]);
    serveFeed([
      commentEntry("g2", minutesAgo(1)),
      commentEntry("g1", minutesAgo(5)),
      e8,
      statusEntry("e2", minutesAgo(30)),
    ]);
    await reconnect(stream);
    await waitFor(() => expect(order()).toEqual(["g2", "g1", "e8", "e2"]));
  });

  test("scrolled away, the gap's rows are held behind N new", async () => {
    const topInView = watchTop();
    const { stream } = await openFeed();
    const e8 = commentEntry("e8", minutesAgo(10));
    stream.send(e8);
    topInView(false);
    serveFeed([
      commentEntry("g2", minutesAgo(1)),
      commentEntry("g1", minutesAgo(5)),
      e8,
      statusEntry("e2", minutesAgo(30)),
    ]);
    await reconnect(stream);
    expect(
      await screen.findByRole("button", { name: "2 new" }),
    ).toBeInTheDocument();
    expect(order()).toEqual(["e8", "e2"]);
    await userEvent.click(screen.getByRole("button", { name: "2 new" }));
    expect(order()).toEqual(["g2", "g1", "e8", "e2"]);
  });
});

describe("a project taken away while filtered to it", () => {
  test("the closed stream reads the feed again, and its 404 clears the project filter", async () => {
    const { asked } = await openFeed();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by project" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: "trail" }));
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

describe("a filter change with arrivals in flight", () => {
  const chooseKai = async () => {
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by bot" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: "Kai" }));
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe("/api/web/events?actor=a-kai"),
    );
  };

  test("drops rows the old stream showed and forgets them, so the new stream can deliver them", async () => {
    const { stream } = await openFeed();
    stream.send(commentEntry("e9", minutesAgo(0)));
    expect(order()).toEqual(["e9", "e2"]);
    await chooseKai();
    await waitFor(() => expect(order()).toEqual(["e2"]));
    expect(document.querySelector(".row-fresh")).toBeNull();
    FakeEventSource.current.open();
    FakeEventSource.current.send(commentEntry("e9", minutesAgo(0)));
    expect(order()).toEqual(["e9", "e2"]);
  });

  test("drops rows held behind N new", async () => {
    const topInView = watchTop();
    const { stream } = await openFeed();
    topInView(false);
    stream.send(commentEntry("e9", minutesAgo(0)));
    expect(screen.getByRole("button", { name: "1 new" })).toBeInTheDocument();
    await chooseKai();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /new$/ }),
      ).not.toBeInTheDocument(),
    );
    expect(order()).toEqual(["e2"]);
  });
});

describe("filters", () => {
  test("offer only what /feed returned, and a choice reopens the stream and the read with it", async () => {
    const { asked } = await openFeed();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by bot" }),
    );
    const options = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(options).toEqual(["All bots", "Kai"]);
    await userEvent.click(await screen.findByRole("option", { name: "Kai" }));
    await waitFor(() => expect(asked.at(-1)?.get("actor")).toBe("a-kai"));
    expect(FakeEventSource.current.url).toBe("/api/web/events?actor=a-kai");
    expect(FakeEventSource.opened[0]?.readyState).toBe(FakeEventSource.CLOSED);
  });
});
