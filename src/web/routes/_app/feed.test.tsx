import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
import { keys } from "@/lib/queries";
import {
  feedPage,
  meView,
  notFound,
  renderApp,
  serveFeed,
  serveInProgress,
  signedInAs,
} from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import {
  alpha,
  commentEntry,
  humanUi,
  issue,
  statusEntry,
} from "@/test/fixtures";
import { server } from "@/test/server";
import { holding, reading, watchFor } from "@/test/watch-for";

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

describe("a product taken away while filtered to it", () => {
  test("the closed stream reads the feed again, and its 404 clears the product filter", async () => {
    const { asked } = await openFeed();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by product" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "trail TRL" }),
    );
    await waitFor(() => expect(asked.at(-1)?.get("product")).toBe("TRL"));
    const filtered = FakeEventSource.current;
    expect(filtered.url).toBe("/api/web/events?product=TRL");

    server.use(
      http.get("/api/web/feed", ({ request }) => {
        const query = new URL(request.url).searchParams;
        asked.push(query);
        return query.has("product")
          ? notFound()
          : HttpResponse.json(feedPage([statusEntry("e2", minutesAgo(30))]));
      }),
    );
    filtered.fail({ closed: true });
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe("/api/web/events"),
    );
    await waitFor(() => expect(asked.at(-1)?.has("product")).toBe(false));
    expect(
      screen.getByRole("combobox", { name: "Filter by product" }),
    ).toHaveTextContent("All products");
  });
});

describe("a product taken away by an access event", () => {
  const alphaProduct = { key: "ALP", name: "alpha" };
  const betaProduct = { key: "BET", name: "beta" };
  type Product = typeof alphaProduct;

  const entryIn = (id: string, minutes: number, product: Product) =>
    commentEntry(id, minutesAgo(minutes), {
      product,
      item: { key: `${product.key}-1`, title: "Read the queue", type: "issue" },
    });

  /**
   * `/me` and `/feed` answering from what the viewer can see when each request lands: a
   * product filter outside it is a 404. `holdFeed` keeps the next `/feed` answer back.
   */
  function serveAccess(
    products: Product[],
    rows: ReturnType<typeof entryIn>[],
  ) {
    const at = { products, rows, held: Promise.resolve() };
    const visible = (key: string) => at.products.some((p) => p.key === key);
    server.use(
      http.get("/api/web/me", () =>
        HttpResponse.json({
          ...meView("member"),
          products: at.products,
          ownerName: "Olive Owner",
        }),
      ),
      http.get("/api/web/feed", async ({ request }) => {
        await at.held;
        const product = new URL(request.url).searchParams.get("product");
        if (product !== null && !visible(product)) return notFound();
        return HttpResponse.json({
          ...feedPage(
            at.rows.filter(
              (e) =>
                e.product !== null &&
                visible(e.product.key) &&
                (product === null || e.product.key === product),
            ),
          ),
          filters: { actors: [alpha], products: at.products, projects: [] },
        });
      }),
    );
    const holdFeed = () => {
      let release = () => {};
      at.held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    };
    return { at, holdFeed };
  }

  const sendAccess = (stream: FakeEventSource) =>
    act(() => {
      stream.dispatchEvent(new MessageEvent("access", { data: "{}" }));
    });

  test("its rows go at once, read, live and held alike, and the read again keeps the rest", async () => {
    const topInView = watchTop();
    signedInAs("member");
    const a1 = entryIn("a1", 30, alphaProduct);
    const b1 = entryIn("b1", 20, betaProduct);
    const { at, holdFeed } = serveAccess([alphaProduct, betaProduct], [b1, a1]);
    renderApp("/");
    await waitFor(() => expect(order()).toEqual(["b1", "a1"]));
    const stream = FakeEventSource.current;
    stream.open();
    const a2 = entryIn("a2", 3, alphaProduct);
    const b2 = entryIn("b2", 2, betaProduct);
    const b3 = entryIn("b3", 1, betaProduct);
    at.rows = [b3, b2, a2, ...at.rows];
    stream.send(a2);
    stream.send(b2);
    topInView(false);
    stream.send(b3);
    expect(order()).toEqual(["b2", "a2", "b1", "a1"]);
    expect(screen.getByRole("button", { name: "1 new" })).toBeInTheDocument();

    const release = holdFeed();
    at.products = [alphaProduct];
    sendAccess(stream);
    // before the read again answers: nothing of beta's is left to paint
    expect(order()).toEqual([]);
    expect(screen.queryByRole("button", { name: /new$/ })).toBeNull();
    release();
    await waitFor(() => expect(order()).toEqual(["a2", "a1"]));
    expect(screen.queryByRole("button", { name: /new$/ })).toBeNull();
  });

  test("a feed filtered to it drops the filter, shows the rest, and offers it no more", async () => {
    signedInAs("member");
    const a1 = entryIn("a1", 30, alphaProduct);
    const b1 = entryIn("b1", 20, betaProduct);
    const { at } = serveAccess([alphaProduct, betaProduct], [b1, a1]);
    const { router } = renderApp("/?product=BET");
    await waitFor(() => expect(order()).toEqual(["b1"]));
    const stream = FakeEventSource.current;
    expect(stream.url).toBe("/api/web/events?product=BET");
    stream.open();
    const b2 = entryIn("b2", 2, betaProduct);
    at.rows = [b2, ...at.rows];
    stream.send(b2);
    expect(order()).toEqual(["b2", "b1"]);

    const shown = watchFor(holding('[data-entry-id^="b"]'));
    // the 404 is a filter on its way out, not a feed that failed to load
    const failed = watchFor(reading("Couldn't load the feed"));
    at.products = [alphaProduct];
    sendAccess(stream);
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitFor(() => expect(order()).toEqual(["a1"]));
    expect(shown()).toBe(false);
    expect(failed()).toBe(false);
    expect(FakeEventSource.current.url).toBe("/api/web/events");
    const productFilter = screen.getByRole("combobox", {
      name: "Filter by product",
    });
    expect(productFilter).toHaveTextContent("All products");
    await userEvent.click(productFilter);
    const options = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(options).toEqual(["All products", "alpha ALP"]);
  });

  test("with a project filter too, only the product filter goes, and no error shows on the way", async () => {
    signedInAs("member");
    const a1 = entryIn("a1", 30, alphaProduct);
    const b1 = entryIn("b1", 20, betaProduct);
    const { at } = serveAccess([alphaProduct, betaProduct], [b1, a1]);
    const { router } = renderApp("/?product=BET&project=launch");
    await waitFor(() => expect(order()).toEqual(["b1"]));
    const stream = FakeEventSource.current;
    stream.open();

    const failed = watchFor(reading("Couldn't load the feed"));
    at.products = [alphaProduct];
    sendAccess(stream);
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ project: "launch" }),
    );
    await waitFor(() => expect(order()).toEqual(["a1"]));
    expect(failed()).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("a filter on a product still visible stays, and the read again brings its new rows", async () => {
    signedInAs("member");
    const b1 = entryIn("b1", 20, betaProduct);
    const { at } = serveAccess([alphaProduct, betaProduct], [b1]);
    const { router } = renderApp("/?product=BET");
    await waitFor(() => expect(order()).toEqual(["b1"]));
    const stream = FakeEventSource.current;
    stream.open();

    // a row only the read again has: proves the read ran, so the filter staying is its answer
    at.rows = [entryIn("b2", 2, betaProduct), ...at.rows];
    sendAccess(stream);
    await waitFor(() => expect(order()).toEqual(["b2", "b1"]));
    await act(() => Promise.resolve());
    expect(router.state.location.search).toEqual({ product: "BET" });
    expect(FakeEventSource.current).toBe(stream);
  });

  test("a row's highlight is gone after the read again", async () => {
    signedInAs("member");
    const a1 = entryIn("a1", 30, alphaProduct);
    const { at, holdFeed } = serveAccess([alphaProduct], [a1]);
    renderApp("/");
    await waitFor(() => expect(order()).toEqual(["a1"]));
    const stream = FakeEventSource.current;
    stream.open();
    const a2 = entryIn("a2", 1, alphaProduct);
    at.rows = [a2, a1];
    stream.send(a2);
    expect(rowFor("a2")).toHaveClass("row-fresh");

    const release = holdFeed();
    sendAccess(stream);
    release();
    await waitFor(() => expect(order()).toEqual(["a2", "a1"]));
    expect(rowFor("a2")).not.toHaveClass("row-fresh");
  });

  test("an entry the stream sends again after the access is shown, not dropped as received", async () => {
    signedInAs("member");
    const a1 = entryIn("a1", 30, alphaProduct);
    const { at } = serveAccess([alphaProduct], [a1]);
    renderApp("/");
    await waitFor(() => expect(order()).toEqual(["a1"]));
    const stream = FakeEventSource.current;
    stream.open();
    const a2 = entryIn("a2", 1, alphaProduct);
    stream.send(a2);
    expect(order()).toEqual(["a2", "a1"]);

    // the read again does not list a2, so only the stream can bring it back
    sendAccess(stream);
    await waitFor(() => expect(order()).toEqual(["a1"]));
    stream.send(a2);
    expect(order()).toEqual(["a2", "a1"]);
    expect(at.rows).toEqual([a1]);
  });

  test("a read already in flight when access lands paints none of its old rows", async () => {
    signedInAs("member");
    const a1 = entryIn("a1", 30, alphaProduct);
    const b1 = entryIn("b1", 20, betaProduct);
    const { at } = serveAccess([alphaProduct, betaProduct], [b1, a1]);
    renderApp("/");
    await waitFor(() => expect(order()).toEqual(["b1", "a1"]));
    const stream = FakeEventSource.current;
    stream.open();

    // the first read after this answers late, from before the access; later ones from after
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    server.use(
      http.get("/api/web/feed", async () => {
        reads += 1;
        if (reads === 1) {
          await held;
          return HttpResponse.json(feedPage([b1, a1]));
        }
        return HttpResponse.json(feedPage([a1]));
      }),
    );
    act(() => {
      stream.dispatchEvent(new Event("reset"));
    });
    await waitFor(() => expect(reads).toBe(1));

    const shown = watchFor(holding('[data-entry-id^="b"]'));
    at.products = [alphaProduct];
    sendAccess(stream);
    await waitFor(() => expect(order()).toEqual(["a1"]));
    release();
    await act(() => Promise.resolve());
    await act(() => Promise.resolve());
    expect(order()).toEqual(["a1"]);
    expect(shown()).toBe(false);
  });

  test("a project filter found gone after an access event is cleared", async () => {
    signedInAs("member");
    const a1 = entryIn("a1", 30, alphaProduct);
    let projectVisible = true;
    server.use(
      http.get("/api/web/feed", ({ request }) =>
        new URL(request.url).searchParams.has("project") && !projectVisible
          ? notFound()
          : HttpResponse.json(feedPage([a1])),
      ),
    );
    const { router } = renderApp("/?project=launch");
    await waitFor(() => expect(order()).toEqual(["a1"]));
    const stream = FakeEventSource.current;
    stream.open();

    projectVisible = false;
    sendAccess(stream);
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitFor(() => expect(order()).toEqual(["a1"]));
    expect(FakeEventSource.current.url).toBe("/api/web/events");
  });

  test("the filter chips keep naming the filter that stays while the feed is read again", async () => {
    signedInAs("member");
    const a1 = entryIn("a1", 30, alphaProduct);
    const b1 = entryIn("b1", 20, betaProduct);
    const { at, holdFeed } = serveAccess([alphaProduct, betaProduct], [b1, a1]);
    renderApp(`/?product=ALP&actor=${alpha.id}`);
    await waitFor(() => expect(order()).toEqual(["a1"]));
    const stream = FakeEventSource.current;
    stream.open();
    const productFilter = screen.getByRole("combobox", {
      name: "Filter by product",
    });
    const botFilter = screen.getByRole("combobox", { name: "Filter by bot" });
    expect(productFilter).toHaveTextContent("alpha");
    expect(botFilter).toHaveTextContent("Alpha");

    const release = holdFeed();
    at.products = [alphaProduct];
    sendAccess(stream);
    expect(productFilter).toHaveTextContent("alpha");
    expect(botFilter).toHaveTextContent("Alpha");
    release();
    await waitFor(() => expect(order()).toEqual(["a1"]));
    expect(productFilter).toHaveTextContent("alpha");
  });

  test("Working now drops what it showed at once, and shows nothing if the read again fails", async () => {
    signedInAs("member");
    const b1 = entryIn("b1", 20, betaProduct);
    serveAccess([alphaProduct, betaProduct], [b1]);
    serveInProgress([
      {
        item: { key: "BET-1", title: "Read the queue" },
        productKey: betaProduct.key,
        bot: alpha,
      },
    ]);
    const workingName = "Alpha BET-1, Read the queue, bot";
    renderApp("/");
    await waitFor(() => expect(order()).toEqual(["b1"]));
    await screen.findByRole("link", { name: workingName });
    const stream = FakeEventSource.current;
    stream.open();

    let answered = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("/api/web/working-now", async () => {
        await held;
        answered = true;
        return notFound();
      }),
    );
    sendAccess(stream);
    expect(screen.queryByRole("link", { name: workingName })).toBeNull();
    release();
    await waitFor(() => expect(answered).toBe(true));
    await act(async () => {});
    expect(screen.queryByRole("link", { name: workingName })).toBeNull();
  });
});

describe("the project filter", () => {
  test("a project chosen reads and streams the feed by its slug", async () => {
    signedInAs("member");
    const asked: URLSearchParams[] = [];
    const page = feedPage([statusEntry("e2", minutesAgo(30))]);
    server.use(
      http.get("/api/web/feed", ({ request }) => {
        asked.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          ...page,
          filters: {
            ...page.filters,
            projects: [{ slug: "human-ui", name: "Human UI launch" }],
          },
        });
      }),
    );
    renderApp("/");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by project" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Human UI launch" }),
    );
    await waitFor(() => expect(asked.at(-1)?.get("project")).toBe("human-ui"));
    expect(FakeEventSource.current.url).toBe(
      "/api/web/events?project=human-ui",
    );
  });

  test("a project taken away while filtered to it clears the project filter", async () => {
    signedInAs("member");
    const asked: URLSearchParams[] = [];
    const page = feedPage([statusEntry("e2", minutesAgo(30))]);
    server.use(
      http.get("/api/web/feed", ({ request }) => {
        asked.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          ...page,
          filters: { ...page.filters, projects: [humanUi] },
        });
      }),
    );
    renderApp("/");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by project" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Human UI launch" }),
    );
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe(
        "/api/web/events?project=human-ui",
      ),
    );
    const filtered = FakeEventSource.current;

    server.use(
      http.get("/api/web/feed", ({ request }) => {
        const query = new URL(request.url).searchParams;
        asked.push(query);
        return query.has("project") ? notFound() : HttpResponse.json(page);
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

describe("one of two filters taken away", () => {
  /** Filters the feed to TRL and Human UI launch, then has the server 404 whatever `gone` names. */
  async function filterBothThenLose(gone: "product" | "project") {
    signedInAs("member");
    const page = feedPage([statusEntry("e2", minutesAgo(30))]);
    const withProjects = {
      ...page,
      filters: { ...page.filters, projects: [humanUi] },
    };
    server.use(
      http.get("/api/web/feed", () => HttpResponse.json(withProjects)),
    );
    renderApp("/");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by product" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "trail TRL" }),
    );
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by project" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Human UI launch" }),
    );
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe(
        "/api/web/events?product=TRL&project=human-ui",
      ),
    );
    const filtered = FakeEventSource.current;
    server.use(
      http.get("/api/web/feed", ({ request }) =>
        new URL(request.url).searchParams.has(gone)
          ? notFound()
          : HttpResponse.json(withProjects),
      ),
    );
    filtered.fail({ closed: true });
  }

  test("a lost project clears the project and keeps the product", async () => {
    await filterBothThenLose("project");
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe("/api/web/events?product=TRL"),
    );
    expect(
      screen.getByRole("combobox", { name: "Filter by project" }),
    ).toHaveTextContent("All projects");
  });

  test("a lost product clears the product and keeps the project", async () => {
    await filterBothThenLose("product");
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe(
        "/api/web/events?project=human-ui",
      ),
    );
    expect(
      screen.getByRole("combobox", { name: "Filter by product" }),
    ).toHaveTextContent("All products");
  });
});

describe("a filter change with arrivals in flight", () => {
  const chooseAlpha = async () => {
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by bot" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: "Alpha" }));
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe("/api/web/events?actor=a-alpha"),
    );
  };

  test("drops rows the old stream showed and forgets them, so the new stream can deliver them", async () => {
    const { stream } = await openFeed();
    stream.send(commentEntry("e9", minutesAgo(0)));
    expect(order()).toEqual(["e9", "e2"]);
    await chooseAlpha();
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
    await chooseAlpha();
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
    expect(options).toEqual(["All bots", "Alpha"]);
    await userEvent.click(await screen.findByRole("option", { name: "Alpha" }));
    await waitFor(() => expect(asked.at(-1)?.get("actor")).toBe("a-alpha"));
    expect(FakeEventSource.current.url).toBe("/api/web/events?actor=a-alpha");
    expect(FakeEventSource.opened[0]?.readyState).toBe(FakeEventSource.CLOSED);
  });
});

describe("the type filter", () => {
  test("a type chosen reads and streams the feed by that type", async () => {
    const { asked } = await openFeed();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by type" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: "Todos" }));
    await waitFor(() => expect(asked.at(-1)?.get("type")).toBe("todo"));
    expect(FakeEventSource.current.url).toBe("/api/web/events?type=todo");
  });
});

describe("filters in the URL", () => {
  const atlas = { key: "ATL", name: "Atlas" };
  const bastion = { key: "BTL", name: "Bastion" };

  /** Answers /feed with `e2` and ATL and BTL as product options, recording each query. */
  function serveNeutralFeed() {
    const asked: URLSearchParams[] = [];
    const page = feedPage([statusEntry("e2", minutesAgo(30))]);
    server.use(
      http.get("/api/web/feed", ({ request }) => {
        asked.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          ...page,
          filters: { ...page.filters, products: [atlas, bastion] },
        });
      }),
    );
    return asked;
  }

  test("a link with ?product=atl&type=todo reads and streams the feed by both", async () => {
    signedInAs("member");
    const asked = serveNeutralFeed();
    renderApp("/?product=atl&type=todo");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    expect(asked[0]?.get("product")).toBe("ATL");
    expect(asked[0]?.get("type")).toBe("todo");
    expect(FakeEventSource.current.url).toBe(
      "/api/web/events?product=ATL&type=todo",
    );
  });

  test("a link with ?type=note reads and streams the feed by notes, and shows Notes chosen", async () => {
    signedInAs("member");
    const asked = serveNeutralFeed();
    renderApp("/?type=note");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    expect(asked[0]?.get("type")).toBe("note");
    expect(FakeEventSource.current.url).toBe("/api/web/events?type=note");
    expect(
      screen.getByRole("combobox", { name: "Filter by type" }),
    ).toHaveTextContent("Notes");
  });

  test("an all-digit ?project= and ?product= read and stream the feed as text", async () => {
    signedInAs("member");
    const asked = serveNeutralFeed();
    renderApp("/?project=2026&product=42");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    expect(asked[0]?.get("project")).toBe("2026");
    expect(asked[0]?.get("product")).toBe("42");
    expect(FakeEventSource.current.url).toBe(
      "/api/web/events?product=42&project=2026",
    );
  });

  test("a ?project= in capitals is the lowercase slug", async () => {
    signedInAs("member");
    const asked = serveNeutralFeed();
    renderApp("/?project=Alpha-Launch");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    expect(asked[0]?.get("project")).toBe("alpha-launch");
  });

  // the router's default parseSearch reads 1E5 as JSON before any validator sees it
  test("a ?product= in exponent form reads as the number the router made of it", async () => {
    signedInAs("member");
    const asked = serveNeutralFeed();
    renderApp("/?product=1E5");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    expect(asked[0]?.get("product")).toBe("100000");
  });

  test("a filter picked survives going to another page and back", async () => {
    signedInAs("member");
    const asked = serveNeutralFeed();
    server.use(
      http.get("/api/web/products", () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const { router } = renderApp("/");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by product" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Atlas ATL" }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ product: "ATL" }),
    );

    await router.navigate({ to: "/products" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/products"),
    );
    router.history.back();

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.location.search).toEqual({ product: "ATL" });
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe("/api/web/events?product=ATL"),
    );
    expect(asked.at(-1)?.get("product")).toBe("ATL");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Filter by product" }),
      ).toHaveTextContent("Atlas"),
    );
  });

  test("an empty value or an unknown type is no filter", async () => {
    signedInAs("member");
    const asked = serveNeutralFeed();
    renderApp("/?product=&actor=&project=&type=epic");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    expect([...(asked[0]?.keys() ?? [])]).toEqual(["limit"]);
    expect(FakeEventSource.current.url).toBe("/api/web/events");
  });

  test("choosing All takes the filter out of the URL and keeps the others", async () => {
    signedInAs("member");
    serveNeutralFeed();
    const { router } = renderApp("/?product=ATL&type=todo");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by type" }),
    );
    await userEvent.click(await screen.findByRole("option", { name: /^All/ }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ product: "ATL" }),
    );
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe("/api/web/events?product=ATL"),
    );
  });

  test("a product found gone after another was picked leaves the new one", async () => {
    signedInAs("member");
    const page = feedPage([statusEntry("e2", minutesAgo(30))]);
    const withProducts = {
      ...page,
      filters: { ...page.filters, products: [atlas, bastion] },
    };
    server.use(
      http.get("/api/web/feed", () => HttpResponse.json(withProducts)),
    );
    const { router, queryClient } = renderApp("/?product=ATL");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    const filtered = FakeEventSource.current;
    expect(filtered.url).toBe("/api/web/events?product=ATL");

    // ATL's 404 waits until BTL has been picked
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let atlAsked = false;
    server.use(
      http.get("/api/web/feed", async ({ request }) => {
        if (new URL(request.url).searchParams.get("product") !== "ATL") {
          return HttpResponse.json(withProducts);
        }
        atlAsked = true;
        await held;
        return notFound();
      }),
    );
    filtered.fail({ closed: true });
    await waitFor(() => expect(atlAsked).toBe(true));
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by product" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: "Bastion BTL" }),
    );
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe("/api/web/events?product=BTL"),
    );
    release();

    // the ATL read has answered 404; clearing on it would replace the URL straight after
    const atlRead = keys.feed({
      actor: null,
      product: "ATL",
      project: null,
      type: null,
    });
    await waitFor(() =>
      expect(queryClient.getQueryState(atlRead)?.status).toBe("error"),
    );
    await act(() => Promise.resolve());
    expect(router.history.location.search).toBe("?product=BTL");
    expect(router.state.location.search).toEqual({ product: "BTL" });
    expect(FakeEventSource.current.url).toBe("/api/web/events?product=BTL");
  });

  test("a product found gone after the viewer opened an item leaves them on the item", async () => {
    signedInAs("member");
    const page = feedPage([statusEntry("e2", minutesAgo(30))]);
    const withProducts = {
      ...page,
      filters: { ...page.filters, products: [atlas, bastion] },
    };
    // ATL's 404 waits until the viewer is on the item
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let atlAsked = 0;
    server.use(
      http.get("/api/web/feed", async () => {
        atlAsked += 1;
        if (atlAsked === 1) return HttpResponse.json(withProducts);
        await held;
        return notFound();
      }),
      http.get("/api/web/items/ATL-1", () =>
        HttpResponse.json(issue({ key: "ATL-1" })),
      ),
    );
    const { router, queryClient } = renderApp("/?product=ATL");
    await waitFor(() => expect(rowFor("e2")).not.toBeNull());
    FakeEventSource.current.fail({ closed: true });
    await waitFor(() => expect(atlAsked).toBe(2));
    await router.navigate({
      to: "/products/$key/$n",
      params: { key: "ATL", n: "1" },
    });
    release();

    const atlRead = keys.feed({
      actor: null,
      product: "ATL",
      project: null,
      type: null,
    });
    await waitFor(() =>
      expect(queryClient.getQueryState(atlRead)?.status).toBe("error"),
    );
    await act(() => Promise.resolve());
    expect(router.state.location.pathname).toBe("/products/ATL/1");
    expect(router.history.location.pathname).toBe("/products/ATL/1");
  });

  test("a bot the feed no longer offers leaves the URL; one it offers stays", async () => {
    signedInAs("member");
    const asked = serveNeutralFeed();
    const { router } = renderApp("/?actor=a-gone&type=todo");
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ type: "todo" }),
    );
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe("/api/web/events?type=todo"),
    );
    expect(asked.at(-1)?.has("actor")).toBe(false);

    await router.navigate({ to: "/", search: { actor: "a-alpha" } });
    await waitFor(() =>
      expect(FakeEventSource.current.url).toBe("/api/web/events?actor=a-alpha"),
    );
    await waitFor(() => expect(asked.at(-1)?.get("actor")).toBe("a-alpha"));
    await act(() => Promise.resolve());
    expect(router.state.location.search).toEqual({ actor: "a-alpha" });
  });
});
