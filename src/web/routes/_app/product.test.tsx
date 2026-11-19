import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test, vi } from "vitest";
import { ITEM_PAGES_MAX } from "@/lib/queries";
import { meView, notFound, renderApp, signedInAs } from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import {
  issueList,
  issueRow,
  itemList,
  noteRow,
  productDetail,
  statusUpdate,
  todoRow,
  trail,
} from "@/test/fixtures";
import { server } from "@/test/server";

/** Answers TRL's reads, recording the status each item-list request asked for. */
function serveProduct() {
  const statuses: (string | null)[] = [];
  server.use(
    http.get("/api/web/products/TRL", () => HttpResponse.json(productDetail())),
    http.get("/api/web/products/TRL/items", ({ request }) => {
      const status = new URL(request.url).searchParams.get("status");
      statuses.push(status);
      // a row under the filter asked for, as the server would answer
      const row = issueRow(status === "in_progress" ? { status } : {});
      return HttpResponse.json(issueList([row]));
    }),
    http.get("/api/web/products/TRL/status-updates", () =>
      HttpResponse.json({ items: [statusUpdate()], nextCursor: null }),
    ),
  );
  return statuses;
}

const selectedTab = () =>
  within(screen.getByRole("tablist", { name: "Filter by status" })).getByRole(
    "tab",
    { selected: true },
  ).textContent;

describe("product page", () => {
  test("?status= picks the tab and the request", async () => {
    signedInAs("member");
    const statuses = serveProduct();
    renderApp("/products/TRL?status=in_progress");
    expect(
      await screen.findAllByText("Human UI: feed, projects, issue page"),
    ).not.toHaveLength(0);
    expect(statuses).toEqual(["in_progress"]);
    expect(selectedTab()).toMatch(/^In progress/);
  });

  test("an unknown status falls back to All", async () => {
    signedInAs("member");
    const statuses = serveProduct();
    renderApp("/products/TRL?status=bogus");
    expect(
      await screen.findAllByText("Human UI: feed, projects, issue page"),
    ).not.toHaveLength(0);
    expect(statuses).toEqual([null]);
    expect(selectedTab()).toMatch(/^All/);
  });

  test("clicking a tab puts it in the URL and asks for it", async () => {
    signedInAs("member");
    const statuses = serveProduct();
    const { router } = renderApp("/products/TRL");
    await screen.findAllByText("Human UI: feed, projects, issue page");
    await userEvent.click(screen.getByRole("tab", { name: /^Done/ }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ status: "done" }),
    );
    await waitFor(() => expect(statuses).toEqual([null, "done"]));
    await userEvent.click(screen.getByRole("tab", { name: /^All/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });
});

/** How many of TRL's item lists have rows in the cache (the held one counts). */
const settledLists = (queryClient: QueryClient) =>
  queryClient
    .getQueriesData({ queryKey: ["product", "TRL", "items"] })
    .filter(([, data]) => data !== undefined).length;

describe("notes section on load", () => {
  /** TRL's items with these note counts; returns the notes requests made. */
  function serveNoteCounts(notes: { current: number; archived: number }) {
    serveProduct();
    const notesAsked: string[] = [];
    server.use(
      http.get("/api/web/products/TRL/items", ({ request }) => {
        if (new URL(request.url).searchParams.get("type") === "note")
          notesAsked.push(request.url);
        const list = issueList([issueRow()]);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes },
        });
      }),
    );
    return notesAsked;
  }

  test("only archived notes: the section says none are current and links the archived", async () => {
    signedInAs("member");
    const notesAsked = serveNoteCounts({ current: 0, archived: 2 });
    const { queryClient } = renderApp("/products/TRL");
    expect(
      await screen.findAllByText("Human UI: feed, projects, issue page"),
    ).not.toHaveLength(0);
    expect(screen.getByRole("heading", { name: /^Notes/ })).toBeInTheDocument();
    expect(screen.getByText("No current notes.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show 2 archived notes" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(notesAsked).toEqual([]);
  });

  test("only archived notes: the section stays while a filter with no rows yet loads", async () => {
    signedInAs("member");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    serveNoteCounts({ current: 0, archived: 2 });
    const notesAsked: string[] = [];
    let heldAnswered = false;
    server.use(
      http.get("/api/web/products/TRL/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        if (query.get("type") === "note") notesAsked.push(request.url);
        // the open issue's list has nothing under In progress, so it can't stand in
        if (query.has("status")) {
          await held;
          heldAnswered = true;
        }
        const list = issueList([issueRow({ status: "open" })]);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes: { current: 0, archived: 2 } },
        });
      }),
    );
    const { queryClient } = renderApp("/products/TRL");
    expect(
      await screen.findAllByText("Human UI: feed, projects, issue page"),
    ).not.toHaveLength(0);
    await userEvent.click(screen.getByRole("tab", { name: /^In progress/ }));
    expect(screen.getByText("No current notes.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show 2 archived notes" }),
    ).toBeInTheDocument();
    release();
    await waitFor(() => expect(heldAnswered).toBe(true));
    await waitFor(() =>
      expect(settledLists(queryClient)).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(notesAsked).toEqual([]);
  });

  test("only archived notes: the section stays while an access event's reread is in flight", async () => {
    signedInAs("member");
    serveNoteCounts({ current: 0, archived: 2 });
    const { queryClient } = renderApp("/products/TRL");
    await screen.findByRole("button", { name: "Show 2 archived notes" });
    const stream = FakeEventSource.current;
    stream.open();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let reread = false;
    // the owner granted another product, so the session the page reads changes mid-reread
    const me = meView("member");
    server.use(
      http.get("/api/web/me", () =>
        HttpResponse.json({
          ...me,
          products: [...me.products, { key: "BET", name: "beta" }],
        }),
      ),
      http.get("/api/web/products/TRL/items", async () => {
        reread = true;
        await answered;
        const list = issueList([issueRow()]);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes: { current: 0, archived: 2 } },
        });
      }),
    );
    act(() => {
      stream.dispatchEvent(new MessageEvent("access", { data: "{}" }));
    });
    await screen.findByRole("link", { name: /beta/ });
    expect(reread).toBe(true);
    expect(
      screen.getByRole("button", { name: "Show 2 archived notes" }),
    ).toBeInTheDocument();
    answer();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(
      screen.getByRole("button", { name: "Show 2 archived notes" }),
    ).toBeInTheDocument();
  });

  test("only archived notes: the section stays when the next tab's list fails", async () => {
    signedInAs("member");
    serveNoteCounts({ current: 0, archived: 2 });
    server.use(
      http.get("/api/web/products/TRL/items", ({ request }) => {
        if (new URL(request.url).searchParams.has("status"))
          return HttpResponse.json({ error: "bad request" }, { status: 400 });
        const list = issueList([issueRow({ status: "open" })]);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes: { current: 0, archived: 2 } },
        });
      }),
    );
    renderApp("/products/TRL");
    expect(
      await screen.findByRole("button", { name: "Show 2 archived notes" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /^In progress/ }));
    expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Show 2 archived notes" }),
    ).toBeInTheDocument();
  });

  test("current notes are read on the list's first page, not after its last", async () => {
    signedInAs("member");
    serveProduct();
    const never = new Promise<void>(() => {});
    server.use(
      http.get("/api/web/products/TRL/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        const notes = { current: 1, archived: 0 };
        const list =
          query.get("type") === "note"
            ? issueList([noteRow()])
            : issueList([issueRow()]);
        if (query.has("cursor")) await never;
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes },
          nextCursor: query.get("type") === "note" ? null : "after-17",
        });
      }),
    );
    renderApp("/products/TRL");
    expect(await screen.findAllByText(noteRow().title)).not.toHaveLength(0);
  });

  test("current notes: the section reads them once, as type note", async () => {
    signedInAs("member");
    const notesAsked = serveNoteCounts({ current: 1, archived: 0 });
    const { queryClient } = renderApp("/products/TRL");
    expect(
      await screen.findByRole("heading", { name: /^Notes/ }),
    ).toBeInTheDocument();
    await waitFor(() => expect(notesAsked.length).toBeGreaterThan(0));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(notesAsked).toHaveLength(1);
    const asked = new URL(notesAsked[0] ?? "", "http://localhost").searchParams;
    expect(asked.get("type")).toBe("note");
    expect(asked.get("status")).toBe("current");
  });

  test("current notes: switching a status tab doesn't read them again", async () => {
    signedInAs("member");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notesAsked: string[] = [];
    let heldAnswered = false;
    serveProduct();
    server.use(
      http.get("/api/web/products/TRL/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        const isNotes = query.get("type") === "note";
        if (isNotes) notesAsked.push(request.url);
        if (!isNotes && query.has("status")) {
          await held;
          heldAnswered = true;
        }
        const list = issueList([isNotes ? noteRow() : issueRow()]);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes: { current: 1, archived: 0 } },
        });
      }),
    );
    const { queryClient } = renderApp("/products/TRL");
    expect(await screen.findAllByText(noteRow().title)).not.toHaveLength(0);
    await userEvent.click(screen.getByRole("tab", { name: /^In progress/ }));
    release();
    await waitFor(() => expect(heldAnswered).toBe(true));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.getAllByText(noteRow().title)).not.toHaveLength(0);
    expect(notesAsked).toHaveLength(1);
  });

  test("a tab whose list counts current notes differently reads them again", async () => {
    signedInAs("member");
    serveProduct();
    const kept = noteRow();
    const archived = noteRow({ key: "TRL-32", title: "Archived since" });
    let current = [kept, archived];
    const notesAsked: string[] = [];
    server.use(
      http.get("/api/web/products/TRL/items", ({ request }) => {
        const isNotes =
          new URL(request.url).searchParams.get("type") === "note";
        if (isNotes) notesAsked.push(request.url);
        const list = issueList(isNotes ? current : [issueRow()]);
        return HttpResponse.json({
          ...list,
          counts: {
            ...list.counts,
            notes: { current: current.length, archived: 2 - current.length },
          },
        });
      }),
    );
    const { queryClient } = renderApp("/products/TRL");
    expect(await screen.findAllByText(archived.title)).not.toHaveLength(0);
    // a bot archives a note while the page sits open
    current = [kept];
    await userEvent.click(screen.getByRole("tab", { name: /^In progress/ }));
    await waitFor(() =>
      expect(screen.queryByText(archived.title)).not.toBeInTheDocument(),
    );
    expect(screen.getAllByText(kept.title)).not.toHaveLength(0);
    expect(screen.getByRole("heading", { name: /^Notes/ })).toHaveTextContent(
      "Notes 1",
    );
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(notesAsked).toHaveLength(2);
  });

  /**
   * TRL's lists as a bot moves notes between reads: `notes` are the current notes, `archived`
   * how many are archived, `work` how many issues and todos; returns that state, counting
   * the notes reads.
   */
  function serveMovingNotes(start: {
    notes: ReturnType<typeof noteRow>[];
    archived: number;
    work: number;
  }) {
    serveProduct();
    const state = { ...start, notesAsked: 0 };
    server.use(
      http.get("/api/web/products/TRL/items", ({ request }) => {
        const isNotes =
          new URL(request.url).searchParams.get("type") === "note";
        if (isNotes) state.notesAsked++;
        const list = issueList(isNotes ? state.notes : [issueRow()]);
        return HttpResponse.json({
          ...list,
          counts: {
            ...list.counts,
            all: { ...list.counts.all, all: state.work },
            notes: { current: state.notes.length, archived: state.archived },
          },
        });
      }),
    );
    return state;
  }

  test("a tab whose list counts archived notes differently reads the current ones again", async () => {
    signedInAs("member");
    const before = noteRow();
    const since = noteRow({ key: "TRL-32", title: "Filed since" });
    const state = serveMovingNotes({ notes: [before], archived: 0, work: 1 });
    const { queryClient } = renderApp("/products/TRL");
    expect(await screen.findAllByText(before.title)).not.toHaveLength(0);
    // a bot archives the note and files another, so as many are current
    state.notes = [since];
    state.archived = 1;
    await userEvent.click(screen.getByRole("tab", { name: /^In progress/ }));
    expect(await screen.findAllByText(since.title)).not.toHaveLength(0);
    expect(screen.queryByText(before.title)).not.toBeInTheDocument();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(state.notesAsked).toBe(2);
  });

  test("a tab whose list counts more issues and todos reads the current notes again", async () => {
    signedInAs("member");
    const converted = noteRow();
    const since = noteRow({ key: "TRL-32", title: "Filed since" });
    const state = serveMovingNotes({
      notes: [converted],
      archived: 0,
      work: 1,
    });
    const { queryClient } = renderApp("/products/TRL");
    expect(await screen.findAllByText(converted.title)).not.toHaveLength(0);
    // a bot makes the note an issue and files another note
    state.notes = [since];
    state.work = 2;
    await userEvent.click(screen.getByRole("tab", { name: /^In progress/ }));
    expect(await screen.findAllByText(since.title)).not.toHaveLength(0);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(state.notesAsked).toBe(2);
  });

  test("current notes as the list: a reread with a new count reads them once", async () => {
    signedInAs("member");
    serveProduct();
    let current = [noteRow()];
    let notesAsked = 0;
    server.use(
      http.get("/api/web/products/TRL/items", () => {
        notesAsked++;
        const list = issueList(current);
        return HttpResponse.json({
          ...list,
          counts: {
            ...list.counts,
            notes: { current: current.length, archived: 0 },
          },
        });
      }),
    );
    const { queryClient } = renderApp("/products/TRL?type=note&status=current");
    expect(await screen.findAllByText(noteRow().title)).not.toHaveLength(0);
    current = [noteRow(), noteRow({ key: "TRL-32", title: "Added since" })];
    await queryClient.refetchQueries({ queryKey: ["product", "TRL", "items"] });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.getAllByText("Added since")).not.toHaveLength(0);
    expect(notesAsked).toBe(2);
  });

  test("a reread whose list moves the count while the notes reread is in flight reads them once", async () => {
    signedInAs("member");
    serveProduct();
    let current = [noteRow()];
    let notesAsked = 0;
    let holdNotes: Promise<void> | null = null;
    let releaseNotes = () => {};
    server.use(
      http.get("/api/web/products/TRL/items", async ({ request }) => {
        const isNotes =
          new URL(request.url).searchParams.get("type") === "note";
        if (isNotes) {
          notesAsked++;
          if (holdNotes) await holdNotes;
        }
        const list = issueList(isNotes ? current : [issueRow()]);
        return HttpResponse.json({
          ...list,
          counts: {
            ...list.counts,
            notes: { current: current.length, archived: 0 },
          },
        });
      }),
    );
    const { queryClient } = renderApp("/products/TRL");
    expect(await screen.findAllByText(noteRow().title)).not.toHaveLength(0);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    // a bot adds a note; a window focus rereads the list and the notes together
    current = [noteRow(), noteRow({ key: "TRL-32", title: "Added since" })];
    holdNotes = new Promise((resolve) => {
      releaseNotes = resolve;
    });
    const reread = queryClient.refetchQueries({
      queryKey: ["product", "TRL", "items"],
    });
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^Notes/ })).toHaveTextContent(
        "Notes 2",
      ),
    );
    releaseNotes();
    await reread;
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.getAllByText("Added since")).not.toHaveLength(0);
    expect(notesAsked).toBe(2);
  });

  test("a tab left before its list answers never writes its older counts or rereads the notes", async () => {
    signedInAs("member");
    serveProduct();
    let releaseInProgress = () => {};
    const inProgressHeld = new Promise<void>((resolve) => {
      releaseInProgress = resolve;
    });
    let notesAsked = 0;
    // settles when the abandoned read ends: aborted, or its answer's body read, the last step before the read writes its counts
    let inProgressSettled = () => {};
    const inProgressDone = new Promise<void>((resolve) => {
      inProgressSettled = resolve;
    });
    const realFetch = globalThis.fetch;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const read = realFetch(input, init);
        if (String(input).includes("status=in_progress")) {
          read.then((response) => {
            const readBody = response.json.bind(response);
            response.json = () => readBody().finally(inProgressSettled);
          }, inProgressSettled);
        }
        return read;
      });
    server.use(
      http.get("/api/web/products/TRL/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        // asked before a bot filed a second note, answered after
        const notes = query.get("status") === "in_progress" ? 1 : 2;
        if (query.get("status") === "in_progress") {
          await inProgressHeld;
        }
        if (query.get("type") === "note") notesAsked++;
        const list = issueList([issueRow()]);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes: { current: notes, archived: 0 } },
        });
      }),
    );
    const { queryClient } = renderApp("/products/TRL");
    const heading = () => screen.getByRole("heading", { name: /^Notes/ });
    await waitFor(() => expect(heading()).toHaveAccessibleName("Notes 2"));
    await userEvent.click(screen.getByRole("tab", { name: /^In progress/ }));
    await userEvent.click(screen.getByRole("tab", { name: /^Done/ }));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    releaseInProgress();
    // an abandoned read that still wrote its counts would show them and start a notes read, which isFetching sees at once
    await inProgressDone;
    await act(async () => {});
    fetchSpy.mockRestore();
    expect(queryClient.isFetching()).toBe(0);
    expect(heading()).toHaveAccessibleName("Notes 2");
    expect(notesAsked).toBe(1);
  });

  test("no notes at all: no section and no notes request", async () => {
    signedInAs("member");
    const notesAsked = serveNoteCounts({ current: 0, archived: 0 });
    const { queryClient } = renderApp("/products/TRL");
    expect(
      await screen.findAllByText("Human UI: feed, projects, issue page"),
    ).not.toHaveLength(0);
    expect(
      screen.queryByRole("heading", { name: /^Notes/ }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(notesAsked).toEqual([]);
  });
});

describe("while the next filter loads", () => {
  /** TRL's All list holds an open and a done row; any other status waits on `release`. */
  function serveHeld() {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = issueRow({ key: "TRL-17", title: "Open one" });
    const done = issueRow({ key: "TRL-18", title: "Done one", status: "done" });
    server.use(
      http.get("/api/web/products/TRL", () =>
        HttpResponse.json(productDetail()),
      ),
      http.get("/api/web/products/TRL/items", async ({ request }) => {
        const status = new URL(request.url).searchParams.get("status");
        if (status === null) return HttpResponse.json(issueList([open, done]));
        await held;
        return HttpResponse.json(issueList([done]));
      }),
      http.get("/api/web/products/TRL/status-updates", () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    return { release, held };
  }

  test("the last list stays under the new tab, filtered to it, with its counts", async () => {
    signedInAs("member");
    const { release } = serveHeld();
    renderApp("/products/TRL");
    expect(await screen.findAllByText("Open one")).not.toHaveLength(0);
    await userEvent.click(screen.getByRole("tab", { name: /^Done/ }));
    expect(selectedTab()).toMatch(/^Done/);
    expect(screen.getByRole("tab", { name: /^Done/ })).toHaveTextContent("24");
    expect(screen.getAllByText("Done one")).not.toHaveLength(0);
    expect(screen.queryByText("Open one")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading")).not.toBeInTheDocument();
    release();
  });

  test("the last list's page-cap line is not shown under the new tab", async () => {
    signedInAs("member");
    const { release, held } = serveHeld();
    server.use(
      http.get("/api/web/products/TRL/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        if (query.get("status") === null) {
          const n = Number(query.get("cursor") ?? 0);
          const row = issueRow({ key: `TRL-${n}`, title: `Row ${n}` });
          return HttpResponse.json({
            ...issueList([row]),
            nextCursor: `${n + 1}`,
          });
        }
        await held;
        return HttpResponse.json(issueList([]));
      }),
    );
    renderApp("/products/TRL");
    expect(
      await screen.findAllByText(
        `Only the first ${ITEM_PAGES_MAX} items are shown.`,
      ),
    ).not.toHaveLength(0);
    await userEvent.click(screen.getByRole("tab", { name: /^Done/ }));
    expect(selectedTab()).toMatch(/^Done/);
    expect(screen.queryAllByText(/items are shown/)).toHaveLength(0);
    release();
  });

  test("a last list with no row under the new tab reads as loading, never as no matches", async () => {
    signedInAs("member");
    const { release, held } = serveHeld();
    const open = issueRow({ key: "TRL-17", title: "Open one" });
    const done = issueRow({ key: "TRL-18", title: "Done one", status: "done" });
    server.use(
      http.get("/api/web/products/TRL/items", async ({ request }) => {
        const status = new URL(request.url).searchParams.get("status");
        if (status === "done") return HttpResponse.json(issueList([done]));
        await held;
        return HttpResponse.json(issueList([open]));
      }),
    );
    const { router } = renderApp("/products/TRL?status=done");
    expect(await screen.findAllByText("Done one")).not.toHaveLength(0);
    await userEvent.click(screen.getByRole("tab", { name: /^Open/ }));
    expect(selectedTab()).toMatch(/^Open/);
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.queryByText(/^No .* are open$/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show all" }),
    ).not.toBeInTheDocument();
    release();
    expect(await screen.findAllByText("Open one")).not.toHaveLength(0);
    expect(router.state.location.search).toEqual({ status: "open" });
  });

  test("a last list with no row under the new tab still lends its counts", async () => {
    signedInAs("member");
    const { release, held } = serveHeld();
    const done = issueRow({ key: "TRL-18", title: "Done one", status: "done" });
    server.use(
      http.get("/api/web/products/TRL/items", async ({ request }) => {
        if (new URL(request.url).searchParams.get("status") === "done")
          return HttpResponse.json(issueList([done]));
        await held;
        return HttpResponse.json(issueList([]));
      }),
    );
    renderApp("/products/TRL?status=done");
    expect(await screen.findAllByText("Done one")).not.toHaveLength(0);
    await userEvent.click(screen.getByRole("tab", { name: /^Open/ }));
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Open/ })).toHaveTextContent("9");
    expect(screen.getByRole("tab", { name: /^Done/ })).toHaveTextContent("24");
    release();
  });

  test("another product's list is never shown while this one loads", async () => {
    signedInAs("member");
    const { release, held } = serveHeld();
    server.use(
      http.get("/api/web/products/DOC", () =>
        HttpResponse.json(productDetail()),
      ),
      http.get("/api/web/products/DOC/items", async () => {
        await held;
        return HttpResponse.json(issueList([]));
      }),
      http.get("/api/web/products/DOC/status-updates", () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const { router } = renderApp("/products/TRL");
    expect(await screen.findAllByText("Open one")).not.toHaveLength(0);
    await router.navigate({ to: "/products/$key", params: { key: "DOC" } });
    await waitFor(() =>
      expect(screen.queryByText("Open one")).not.toBeInTheDocument(),
    );
    release();
  });
});

describe("type filter", () => {
  /** Answers TRL's reads, recording each item-list request's type and status. */
  function serveTyped() {
    const asked: string[] = [];
    server.use(
      http.get("/api/web/products/TRL", () =>
        HttpResponse.json(productDetail()),
      ),
      http.get("/api/web/products/TRL/items", ({ request }) => {
        const params = new URL(request.url).searchParams;
        asked.push(`${params.get("type")} ${params.get("status")}`);
        const rows =
          params.get("type") === "todo" ? [todoRow()] : [issueRow(), todoRow()];
        // the counts ignore the filters, as the server's do
        return HttpResponse.json({
          ...itemList(rows),
          counts: itemList([issueRow(), todoRow()]).counts,
        });
      }),
      http.get("/api/web/products/TRL/status-updates", () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    return asked;
  }

  test("?type= goes to the API with the status, and an unknown type is All", async () => {
    signedInAs("member");
    const asked = serveTyped();
    renderApp("/products/TRL?type=todo&status=open");
    expect(await screen.findAllByText(todoRow().title)).not.toHaveLength(0);
    expect(asked).toEqual(["todo open"]);
    expect(
      screen.queryByText("Human UI: feed, projects, issue page"),
    ).not.toBeInTheDocument();
    cleanup();

    const again = serveTyped();
    renderApp("/products/TRL?type=epic");
    await screen.findAllByText("Human UI: feed, projects, issue page");
    expect(again).toEqual(["null null"]);
  });

  test("picking Todos puts it in the URL beside the status and asks for it", async () => {
    signedInAs("member");
    const asked = serveTyped();
    const { router } = renderApp("/products/TRL?status=open");
    await screen.findAllByText("Human UI: feed, projects, issue page");
    const [todos] = screen.getAllByRole("button", { name: /^Todos/ });
    if (!todos) throw new Error("no Todos toggle");
    await userEvent.click(todos);
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        status: "open",
        type: "todo",
      }),
    );
    await waitFor(() => expect(asked).toEqual(["null open", "todo open"]));
  });
});

describe("notes filters in the URL", () => {
  const retired = noteRow({
    key: "TRL-32",
    title: "Retired note",
    status: "archived",
  });

  /** TRL with one current and one archived note; returns each request's type and status. */
  function serveNotes() {
    serveProduct();
    const asked: string[] = [];
    server.use(
      http.get("/api/web/products/TRL/items", ({ request }) => {
        const params = new URL(request.url).searchParams;
        const type = params.get("type");
        const status = params.get("status");
        asked.push(`${type} ${status}`);
        const rows =
          type !== "note"
            ? [issueRow()]
            : status === "archived"
              ? [retired]
              : [noteRow()];
        const list = issueList(rows);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes: { current: 1, archived: 1 } },
        });
      }),
    );
    return asked;
  }

  test("Show archived note puts type and status in the URL and asks for them", async () => {
    signedInAs("member");
    const asked = serveNotes();
    const { router } = renderApp("/products/TRL");
    await screen.findAllByText(noteRow().title);
    await userEvent.click(
      screen.getByRole("button", { name: "Show 1 archived note" }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        type: "note",
        status: "archived",
      }),
    );
    expect(await screen.findAllByText(retired.title)).not.toHaveLength(0);
    expect(asked).toContain("note archived");
    expect(selectedTab()).toMatch(/^Archived/);
    expect(
      screen.queryByRole("button", { name: "Show 1 archived note" }),
    ).not.toBeInTheDocument();
  });

  test("?type=note&status=archived picks the Archived tab and asks for archived notes", async () => {
    signedInAs("member");
    const asked = serveNotes();
    renderApp("/products/TRL?type=note&status=archived");
    expect(await screen.findAllByText(retired.title)).not.toHaveLength(0);
    expect(asked).toEqual(["note archived"]);
    expect(selectedTab()).toMatch(/^Archived/);
    expect(screen.queryByText(noteRow().title)).not.toBeInTheDocument();
  });

  test("past the page cap the Notes section counts what it shows, and Show all notes lists them", async () => {
    signedInAs("member");
    serveProduct();
    const total = 25;
    let notePages = 0;
    server.use(
      http.get("/api/web/products/TRL/items", ({ request }) => {
        const isNotes =
          new URL(request.url).searchParams.get("type") === "note";
        if (!isNotes) {
          return HttpResponse.json({
            ...issueList([issueRow()]),
            counts: {
              ...issueList([]).counts,
              notes: { current: total, archived: 0 },
            },
          });
        }
        notePages++;
        const list = issueList([
          noteRow({ key: `TRL-${notePages}`, title: `Note ${notePages}` }),
        ]);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes: { current: total, archived: 0 } },
          nextCursor: `after-${notePages}`,
        });
      }),
    );
    const { router } = renderApp("/products/TRL");
    const section = await screen.findByRole("region", { name: /^Notes/ });
    expect(
      await within(section).findByText(
        `Showing ${ITEM_PAGES_MAX} of ${total} notes`,
      ),
    ).toBeVisible();
    expect(notePages).toBe(ITEM_PAGES_MAX);
    await userEvent.click(
      within(section).getByRole("button", { name: "Show all notes" }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        type: "note",
        status: "current",
      }),
    );
    // the notes are now the list, so the section's cap line is gone and the rows remain
    expect(screen.queryByText(/^Showing \d+ of/)).not.toBeInTheDocument();
    expect(
      await screen.findAllByText(`Note ${ITEM_PAGES_MAX}`),
    ).not.toHaveLength(0);
  });
});

describe("pages", () => {
  test("rows past the first page are read and drawn", async () => {
    signedInAs("member");
    serveProduct();
    const cursors: (string | null)[] = [];
    server.use(
      http.get("/api/web/products/TRL/items", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        const page = cursor
          ? issueList([issueRow({ key: "TRL-1", title: "Second page row" })])
          : issueList([issueRow()]);
        return HttpResponse.json({
          ...page,
          nextCursor: cursor ? null : "after-17",
        });
      }),
    );
    renderApp("/products/TRL");
    expect(await screen.findAllByText("Second page row")).not.toHaveLength(0);
    expect(
      screen.getAllByText("Human UI: feed, projects, issue page"),
    ).not.toHaveLength(0);
    expect(cursors).toEqual([null, "after-17"]);
    expect(screen.queryByText(/items are shown/)).toBeNull();
  });

  test("a list the viewer tabs away from stops reading its pages", async () => {
    signedInAs("member");
    serveProduct();
    let laterPageAsked = false;
    let laterPageAbandoned = false;
    server.use(
      http.get("/api/web/products/TRL/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        if (query.has("cursor")) {
          laterPageAsked = true;
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve()),
          );
          laterPageAbandoned = true;
        }
        return HttpResponse.json({
          ...issueList([issueRow()]),
          nextCursor: query.has("status") ? null : "after-17",
        });
      }),
    );
    renderApp("/products/TRL");
    await waitFor(() => expect(laterPageAsked).toBe(true));
    await userEvent.click(screen.getByRole("tab", { name: /^In progress/ }));
    await waitFor(() => expect(laterPageAbandoned).toBe(true));
  });

  test("past the page cap the page says rows are missing", async () => {
    signedInAs("member");
    serveProduct();
    let asked = 0;
    server.use(
      http.get("/api/web/products/TRL/items", () => {
        asked++;
        const row = issueRow({ key: `TRL-${asked}`, title: `Row ${asked}` });
        return HttpResponse.json({
          ...issueList([row]),
          nextCursor: `after-${asked}`,
        });
      }),
    );
    renderApp("/products/TRL");
    // one row a page, so the cap's pages hold ITEM_PAGES_MAX rows
    expect(
      await screen.findAllByText("Only the first 10 items are shown."),
    ).not.toHaveLength(0);
    expect(asked).toBe(ITEM_PAGES_MAX);
    expect(screen.getAllByText(`Row ${ITEM_PAGES_MAX}`)).not.toHaveLength(0);
  });
});

describe("links", () => {
  test("the product's own row in the sidebar marks the page", async () => {
    signedInAs("member");
    serveProduct();
    renderApp("/products/TRL");
    await screen.findAllByText("Human UI: feed, projects, issue page");
    const products = screen.getByRole("navigation", { name: "Products" });
    expect(
      within(products).getByRole("link", { name: "trail TRL" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("/products/trl is the TRL page in place, filters and all", async () => {
    signedInAs("member");
    const statuses = serveProduct();
    const { router } = renderApp("/products/trl?status=in_progress");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/products/TRL"),
    );
    expect(router.state.location.search).toEqual({ status: "in_progress" });
    expect(router.history.length).toBe(1);
    await screen.findAllByText("Human UI: feed, projects, issue page");
    const products = screen.getByRole("navigation", { name: "Products" });
    expect(
      within(products).getByRole("link", { name: "trail TRL" }),
    ).toHaveAttribute("aria-current", "page");
    expect(statuses).toEqual(["in_progress"]);
  });

  test("an issue row's link is described by its meta line", async () => {
    signedInAs("member");
    serveProduct();
    renderApp("/products/TRL");
    const links = await screen.findAllByRole("link", {
      name: "TRL-17 Human UI: feed, projects, issue page",
    });
    // the 375 list's row; the 1440 table names its row by cells instead
    const row = links.find((link) => link.closest("ul"));
    expect(row).toHaveAccessibleDescription(/Beta/);
  });

  test("a link to the page you're on carries only the component's own aria-current", async () => {
    signedInAs("member");
    serveProduct();
    server.use(
      http.get("/api/web/search", () =>
        HttpResponse.json({ items: [], products: [trail], projects: [] }),
      ),
    );
    renderApp("/products/TRL");
    await screen.findAllByText("Human UI: feed, projects, issue page");
    const [box] = screen.getAllByRole("searchbox", { name: "Search issues" });
    if (!box) throw new Error("no search box");
    await userEvent.type(box, "trail");
    const results = await screen.findByRole("list", { name: "Search results" });
    expect(within(results).getByRole("link")).not.toHaveAttribute(
      "aria-current",
    );
  });
});

describe("not found", () => {
  async function notFoundMarkup(path: string) {
    signedInAs("member");
    server.use(
      http.get("/api/web/products/:key", notFound),
      http.get("/api/web/products/:key/items", notFound),
      http.get("/api/web/products/:key/status-updates", notFound),
      http.get("/api/web/items/:key", notFound),
    );
    renderApp(path);
    await screen.findByRole("heading", { name: "Page not found", level: 1 });
    // the panel's heading is the page's only one: the shell draws none
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    // useId values count up across renders; only the markup itself must match
    const markup = document.body.innerHTML.replace(/_r_\w+_/g, "_id_");
    cleanup();
    return markup;
  }

  test("a hidden project, a hidden issue and an unknown URL render the same page", async () => {
    const unknown = await notFoundMarkup("/no-such-page");
    expect(unknown).toContain(
      "This page doesn't exist, or you don't have access to it.",
    );
    expect(await notFoundMarkup("/products/SEC")).toBe(unknown);
    expect(await notFoundMarkup("/products/SEC/1")).toBe(unknown);
    expect(await notFoundMarkup("/issues/SEC-1")).toBe(unknown);
  });
});
