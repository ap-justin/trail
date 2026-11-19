import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { createQueryClient, ITEM_PAGES_MAX, keys } from "@/lib/queries";
import { notFound, renderApp, signedInAs } from "@/test/app";
import { FakeEventSource } from "@/test/event-source";
import {
  issueRow,
  noteRow,
  openBot,
  projectDetail,
  projectItems,
  statusUpdate,
  todoRow,
  trail,
} from "@/test/fixtures";
import { server } from "@/test/server";
import { reading, watchFor } from "@/test/watch-for";

/** Answers Human UI launch's reads, recording each item-list request's query. */
function serveProject(detail = projectDetail()) {
  const asked: string[] = [];
  server.use(
    http.get("/api/web/projects/human-ui", () => HttpResponse.json(detail)),
    http.get("/api/web/projects/human-ui/items", ({ request }) => {
      const params = new URL(request.url).searchParams;
      asked.push(
        ["product", "type", "status"]
          .map((name) => `${name}=${params.get(name)}`)
          .join(" "),
      );
      return HttpResponse.json(
        projectItems([
          { product: openBot, items: [issueRow({ key: "OPB-3" })] },
          { product: trail, items: [todoRow()] },
        ]),
      );
    }),
    http.get("/api/web/projects/human-ui/status-updates", () =>
      HttpResponse.json({ items: [statusUpdate()], nextCursor: null }),
    ),
  );
  return asked;
}

const currentSection = () => {
  const nav = screen.getAllByRole("navigation")[0];
  if (!nav) throw new Error("no navigation");
  return within(nav)
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent);
};

describe("project page", () => {
  test("draws the project, its items and its status updates, with Projects current", async () => {
    signedInAs("member");
    const asked = serveProject();
    renderApp("/projects/human-ui");
    expect(await screen.findAllByText(todoRow().title)).not.toHaveLength(0);
    expect(
      screen.getAllByText("SSE feed shipped. Human UI design is in review."),
    ).not.toHaveLength(0);
    expect(screen.getAllByText("Human UI launch")).not.toHaveLength(0);
    expect(asked).toEqual(["product=null type=null status=null"]);
    expect(currentSection()).toEqual(["Projects"]);
  });

  test("?product=, ?type= and ?status= go to the items request", async () => {
    signedInAs("member");
    const asked = serveProject();
    renderApp("/projects/human-ui?product=TRL&type=todo&status=open");
    await screen.findAllByText(todoRow().title);
    expect(asked).toEqual(["product=TRL type=todo status=open"]);
  });

  test("?product= in lowercase is that product, in the request and the filter", async () => {
    signedInAs("member");
    const asked = serveProject(
      projectDetail({ products: [{ key: "ATL", name: "Atlas" }] }),
    );
    renderApp("/projects/human-ui?product=atl");
    await waitFor(() =>
      expect(asked).toEqual(["product=ATL type=null status=null"]),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("combobox", { name: "Filter by product" })[0],
      ).toHaveTextContent("Atlas"),
    );
  });

  test("an all-digit ?product= is that product, in the request and the filter", async () => {
    signedInAs("member");
    const asked = serveProject(
      projectDetail({ products: [{ key: "42", name: "Beta" }] }),
    );
    renderApp("/projects/human-ui?product=42");
    await waitFor(() =>
      expect(asked).toEqual(["product=42 type=null status=null"]),
    );
    await waitFor(() =>
      expect(
        screen.getAllByRole("combobox", { name: "Filter by product" })[0],
      ).toHaveTextContent("Beta"),
    );
  });

  test("an empty ?product= is All, and the items don't wait on the project", async () => {
    signedInAs("member");
    const asked = serveProject();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("/api/web/projects/human-ui", async () => {
        await held;
        return HttpResponse.json(projectDetail());
      }),
    );
    renderApp("/projects/human-ui?product=");
    await waitFor(() =>
      expect(asked).toEqual(["product=null type=null status=null"]),
    );
    release();
  });

  test("a product the project doesn't draw from, or an unknown type or status, is All", async () => {
    signedInAs("member");
    const asked = serveProject();
    renderApp("/projects/human-ui?product=SEC&type=epic&status=triage");
    await screen.findAllByText(todoRow().title);
    expect(asked).toEqual(["product=null type=null status=null"]);
  });

  test("clicking a tab keeps the product in the URL and asks for both", async () => {
    signedInAs("member");
    const asked = serveProject();
    const { router } = renderApp("/projects/human-ui?product=TRL");
    await screen.findAllByText(todoRow().title);
    await userEvent.click(screen.getByRole("tab", { name: /^Done/ }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        product: "TRL",
        status: "done",
      }),
    );
    await waitFor(() =>
      expect(asked).toEqual([
        "product=TRL type=null status=null",
        "product=TRL type=null status=done",
      ]),
    );
  });

  test("a project with products the viewer can't see says so", async () => {
    signedInAs("member");
    serveProject(projectDetail({ hiddenProducts: true }));
    renderApp("/projects/human-ui");
    expect(
      await screen.findAllByText(
        "Items from products you can't see are not shown.",
      ),
    ).not.toHaveLength(0);
  });

  test("with ?product=, Retry after a failed project read brings back the items too", async () => {
    signedInAs("member");
    const asked = serveProject();
    let projectReads = 0;
    server.use(
      http.get("/api/web/projects/human-ui", () =>
        ++projectReads === 1
          ? HttpResponse.json({ error: "unavailable" }, { status: 503 })
          : HttpResponse.json(projectDetail()),
      ),
    );
    renderApp("/projects/human-ui?product=TRL");
    await userEvent.click(
      await screen.findByRole("button", { name: "Try again" }),
    );
    expect(await screen.findAllByText(todoRow().title)).not.toHaveLength(0);
    expect(asked).toEqual(["product=TRL type=null status=null"]);
  });
});

describe("while the next filter loads", () => {
  /** Human UI launch's items, read at once unfiltered and held for any filter until `release`. */
  function serveHeld() {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    serveProject();
    server.use(
      http.get("/api/web/projects/human-ui/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        const both = [
          { product: openBot, items: [issueRow({ key: "OPB-3" })] },
          { product: trail, items: [todoRow()] },
        ];
        const filtered = ["product", "type", "status"].some((f) =>
          query.has(f),
        );
        if (!filtered) return HttpResponse.json(projectItems(both));
        await held;
        return HttpResponse.json(projectItems(both.slice(1)));
      }),
    );
    return release;
  }

  const allTab = () => screen.getByRole("tab", { name: /^All/ });

  test("a new status tab never shows the last list's group counts, which counted every status", async () => {
    signedInAs("member");
    serveProject();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("/api/web/projects/human-ui/items", async ({ request }) => {
        const list = projectItems([{ product: trail, items: [todoRow()] }]);
        if (new URL(request.url).searchParams.has("status")) {
          await held;
          return HttpResponse.json(list);
        }
        // under All the group counts its rows of every status
        return HttpResponse.json({
          ...list,
          groups: list.groups.map((g) => ({ ...g, count: 3 })),
        });
      }),
    );
    renderApp("/projects/human-ui");
    expect(await screen.findAllByText("3 issues and todos")).not.toHaveLength(
      0,
    );
    await userEvent.click(screen.getByRole("tab", { name: /^Open/ }));
    await waitFor(() =>
      expect(screen.queryAllByText("3 issues and todos")).toHaveLength(0),
    );
    release();
    expect(await screen.findAllByText("1 issue or todo")).not.toHaveLength(0);
  });

  test("a new product drops the last counts, which counted the other products", async () => {
    signedInAs("member");
    const release = serveHeld();
    const { router } = renderApp("/projects/human-ui");
    expect(await screen.findAllByText(todoRow().title)).not.toHaveLength(0);
    await router.navigate({
      to: "/projects/$slug",
      params: { slug: "human-ui" },
      search: { product: "TRL" },
    });
    await waitFor(() => expect(allTab()).not.toHaveTextContent("2"));
    release();
    await waitFor(() => expect(allTab()).toHaveTextContent("1"));
  });

  test("Open then Done keeps the tab counts, which follow only the product", async () => {
    signedInAs("member");
    serveProject();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = issueRow({ key: "TRL-7", status: "open" });
    const done = [
      issueRow({ key: "TRL-8", status: "done" }),
      issueRow({ key: "TRL-9", status: "done" }),
    ];
    server.use(
      http.get("/api/web/projects/human-ui/items", async ({ request }) => {
        const status = new URL(request.url).searchParams.get("status");
        const list = projectItems([{ product: trail, items: [open, ...done] }]);
        if (status === "done") await held;
        return HttpResponse.json(list);
      }),
    );
    renderApp("/projects/human-ui?status=open");
    const doneTab = () => screen.getByRole("tab", { name: /^Done/ });
    await waitFor(() => expect(doneTab()).toHaveTextContent("2"));
    await userEvent.click(doneTab());
    await waitFor(() =>
      expect(doneTab()).toHaveAttribute("aria-selected", "true"),
    );
    expect(doneTab()).toHaveTextContent("2");
    expect(screen.getByRole("tab", { name: /^Open/ })).toHaveTextContent("1");
    release();
  });

  test("Open then Done reads the notes once, since their counts follow only the product", async () => {
    signedInAs("member");
    serveProject();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notesAsked: string[] = [];
    let heldAnswered = false;
    server.use(
      http.get("/api/web/projects/human-ui/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        const list = projectItems([{ product: trail, items: [todoRow()] }]);
        // the counts follow only the product filter, so the notes list's are the same
        const counts = { ...list.counts, notes: { current: 1, archived: 0 } };
        if (query.get("type") === "note") {
          notesAsked.push(request.url);
          return HttpResponse.json({
            ...projectItems([{ product: trail, items: [noteRow()] }]),
            counts,
          });
        }
        if (query.has("status")) {
          await held;
          heldAnswered = true;
        }
        return HttpResponse.json({ ...list, counts });
      }),
    );
    const { queryClient } = renderApp("/projects/human-ui");
    const notes = () => screen.getByRole("region", { name: /^Notes/ });
    expect(
      await within(
        await screen.findByRole("region", { name: /^Notes/ }),
      ).findByText(noteRow().title),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: /^Open/ }));
    await userEvent.click(screen.getByRole("tab", { name: /^Done/ }));
    release();
    await waitFor(() => expect(heldAnswered).toBe(true));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(within(notes()).getByText(noteRow().title)).toBeVisible();
    expect(notesAsked).toHaveLength(1);
  });
});

/** How many of the project's item lists have rows in the cache (the held one counts). */
const settledLists = (queryClient: QueryClient) =>
  queryClient
    .getQueriesData({ queryKey: ["project", "human-ui", "items"] })
    .filter(([, data]) => data !== undefined).length;

describe("notes section on load", () => {
  /** Human UI launch's items with these note counts; returns the notes requests made. */
  function serveNoteCounts(notes: { current: number; archived: number }) {
    serveProject();
    const notesAsked: string[] = [];
    server.use(
      http.get("/api/web/projects/human-ui/items", ({ request }) => {
        if (new URL(request.url).searchParams.get("type") === "note")
          notesAsked.push(request.url);
        const list = projectItems([{ product: trail, items: [todoRow()] }]);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes },
        });
      }),
    );
    return notesAsked;
  }

  test("under ?product=, the current notes are that product's", async () => {
    signedInAs("member");
    const notesAsked = serveNoteCounts({ current: 1, archived: 0 });
    const { queryClient } = renderApp("/projects/human-ui?product=TRL");
    await waitFor(() => expect(notesAsked).toHaveLength(1));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(notesAsked).toHaveLength(1);
    const query = new URL(notesAsked[0] ?? "").searchParams;
    expect(
      ["product", "type", "status"].map((name) => query.get(name)),
    ).toEqual(["TRL", "note", "current"]);
  });

  test("under ?product=, all products' cached note counts wait on the project too", async () => {
    signedInAs("member");
    const notesAsked = serveNoteCounts({ current: 1, archived: 0 });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("/api/web/projects/human-ui", async () => {
        await held;
        return HttpResponse.json(projectDetail());
      }),
    );
    const queryClient = createQueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(keys.projectNoteCounts("human-ui", null), {
      ...projectItems([]).counts,
      notes: { current: 3, archived: 0 },
    });
    renderApp("/projects/human-ui?product=TRL", queryClient);
    // all but the held project read
    await waitFor(() => expect(queryClient.isFetching()).toBe(1));
    expect(
      screen.queryByRole("heading", { name: /^Notes/ }),
    ).not.toBeInTheDocument();
    expect(notesAsked).toEqual([]);
    release();
    await waitFor(() => expect(notesAsked).toHaveLength(1));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(notesAsked).toHaveLength(1);
    expect(new URL(notesAsked[0] ?? "").searchParams.get("product")).toBe(
      "TRL",
    );
  });

  test("only archived notes: the section says none are current and links the archived", async () => {
    signedInAs("member");
    const notesAsked = serveNoteCounts({ current: 0, archived: 2 });
    const { queryClient } = renderApp("/projects/human-ui");
    expect(await screen.findAllByText(todoRow().title)).not.toHaveLength(0);
    expect(screen.getByRole("heading", { name: /^Notes/ })).toBeInTheDocument();
    expect(screen.getByText("No current notes.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show 2 archived notes" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(notesAsked).toEqual([]);
  });

  test("only archived notes: the section stays while the next tab's list loads", async () => {
    signedInAs("member");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    serveNoteCounts({ current: 0, archived: 2 });
    const notesAsked: string[] = [];
    let heldAnswered = false;
    server.use(
      http.get("/api/web/projects/human-ui/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        if (query.get("type") === "note") notesAsked.push(request.url);
        if (query.has("status")) {
          await held;
          heldAnswered = true;
        }
        const list = projectItems([{ product: trail, items: [todoRow()] }]);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes: { current: 0, archived: 2 } },
        });
      }),
    );
    const { queryClient } = renderApp("/projects/human-ui");
    expect(await screen.findAllByText(todoRow().title)).not.toHaveLength(0);
    await userEvent.click(screen.getByRole("tab", { name: /^Open/ }));
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

  test("a new product keeps the last note counts until its own list counts them", async () => {
    signedInAs("member");
    serveProject();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("/api/web/projects/human-ui/items", async ({ request }) => {
        const isTrl = new URL(request.url).searchParams.has("product");
        if (isTrl) await held;
        const list = projectItems([{ product: trail, items: [todoRow()] }]);
        return HttpResponse.json({
          ...list,
          counts: {
            ...list.counts,
            notes: { current: 0, archived: isTrl ? 1 : 2 },
          },
        });
      }),
    );
    const { router } = renderApp("/projects/human-ui");
    expect(
      await screen.findByRole("button", { name: "Show 2 archived notes" }),
    ).toBeInTheDocument();
    await router.navigate({
      to: "/projects/$slug",
      params: { slug: "human-ui" },
      search: { product: "TRL" },
    });
    expect(
      screen.getByRole("button", { name: "Show 2 archived notes" }),
    ).toBeInTheDocument();
    release();
    expect(
      await screen.findByRole("button", { name: "Show 1 archived note" }),
    ).toBeInTheDocument();
  });

  test("a new product's notes wait for its own counts, not the last product's", async () => {
    signedInAs("member");
    serveProject();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notesAsked: string[] = [];
    server.use(
      http.get("/api/web/projects/human-ui/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        const isTrl = query.has("product");
        if (query.get("type") === "note") notesAsked.push(request.url);
        else if (isTrl) await held;
        const list = projectItems([{ product: trail, items: [todoRow()] }]);
        // every current note is another product's
        return HttpResponse.json({
          ...list,
          counts: {
            ...list.counts,
            notes: isTrl
              ? { current: 0, archived: 1 }
              : { current: 1, archived: 0 },
          },
        });
      }),
    );
    const { router, queryClient } = renderApp("/projects/human-ui");
    await waitFor(() => expect(notesAsked).toHaveLength(1));
    await router.navigate({
      to: "/projects/$slug",
      params: { slug: "human-ui" },
      search: { product: "TRL" },
    });
    expect(screen.getByRole("heading", { name: /^Notes/ })).toBeInTheDocument();
    release();
    expect(await screen.findByText("No current notes.")).toBeInTheDocument();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(notesAsked).toHaveLength(1);
  });

  test("a new product whose list fails drops the last product's note counts", async () => {
    signedInAs("member");
    serveNoteCounts({ current: 1, archived: 0 });
    server.use(
      http.get("/api/web/projects/human-ui/items", ({ request }) => {
        const query = new URL(request.url).searchParams;
        if (query.has("product"))
          return HttpResponse.json({ error: "bad request" }, { status: 400 });
        const list = projectItems([{ product: trail, items: [noteRow()] }]);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes: { current: 1, archived: 0 } },
        });
      }),
    );
    const { router } = renderApp("/projects/human-ui");
    expect(
      await screen.findByRole("heading", { name: /^Notes/ }),
    ).toBeInTheDocument();
    await router.navigate({
      to: "/projects/$slug",
      params: { slug: "human-ui" },
      search: { product: "TRL" },
    });
    expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
    expect(
      screen.queryByRole("heading", { name: /^Notes/ }),
    ).not.toBeInTheDocument();
  });

  test("only archived notes: the section stays when the next tab's list fails", async () => {
    signedInAs("member");
    serveNoteCounts({ current: 0, archived: 2 });
    server.use(
      http.get("/api/web/projects/human-ui/items", ({ request }) => {
        if (new URL(request.url).searchParams.has("status"))
          return HttpResponse.json({ error: "bad request" }, { status: 400 });
        const list = projectItems([{ product: trail, items: [todoRow()] }]);
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes: { current: 0, archived: 2 } },
        });
      }),
    );
    renderApp("/projects/human-ui");
    expect(
      await screen.findByRole("button", { name: "Show 2 archived notes" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /^Open/ }));
    expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Show 2 archived notes" }),
    ).toBeInTheDocument();
  });

  test("current notes are read on the list's first page, not after its last", async () => {
    signedInAs("member");
    serveProject();
    const never = new Promise<void>(() => {});
    server.use(
      http.get("/api/web/projects/human-ui/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        const isNotes = query.get("type") === "note";
        const list = projectItems([
          { product: trail, items: [isNotes ? noteRow() : todoRow()] },
        ]);
        if (query.has("cursor")) await never;
        return HttpResponse.json({
          ...list,
          counts: { ...list.counts, notes: { current: 1, archived: 0 } },
          nextCursor: isNotes ? null : "after-17",
        });
      }),
    );
    renderApp("/projects/human-ui");
    expect(await screen.findAllByText(noteRow().title)).not.toHaveLength(0);
  });

  test("a tab whose list counts current notes differently reads them again", async () => {
    signedInAs("member");
    serveProject();
    const kept = noteRow();
    const archived = noteRow({ key: "TRL-32", title: "Archived since" });
    let current = [kept, archived];
    const notesAsked: string[] = [];
    server.use(
      http.get("/api/web/projects/human-ui/items", ({ request }) => {
        const isNotes =
          new URL(request.url).searchParams.get("type") === "note";
        if (isNotes) notesAsked.push(request.url);
        const list = projectItems([
          { product: trail, items: isNotes ? current : [todoRow()] },
        ]);
        return HttpResponse.json({
          ...list,
          counts: {
            ...list.counts,
            notes: { current: current.length, archived: 2 - current.length },
          },
        });
      }),
    );
    const { queryClient } = renderApp("/projects/human-ui");
    expect(await screen.findAllByText(archived.title)).not.toHaveLength(0);
    // a bot archives a note while the page sits open
    current = [kept];
    await userEvent.click(screen.getByRole("tab", { name: /^Open/ }));
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

  test("no notes at all: no section and no notes request", async () => {
    signedInAs("member");
    const notesAsked = serveNoteCounts({ current: 0, archived: 0 });
    const { queryClient } = renderApp("/projects/human-ui");
    expect(await screen.findAllByText(todoRow().title)).not.toHaveLength(0);
    expect(
      screen.queryByRole("heading", { name: /^Notes/ }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(notesAsked).toEqual([]);
  });

  test("a product revoked while on the Notes tab: back on All, the section never shows its notes", async () => {
    signedInAs("member");
    serveProject();
    let revoked = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revokedNote = noteRow({ key: "OPB-9", title: "Read the bot queue" });
    server.use(
      http.get("/api/web/projects/human-ui/items", async ({ request }) => {
        const query = new URL(request.url).searchParams;
        const counts = {
          ...projectItems([]).counts,
          notes: { current: 1, archived: 0 },
        };
        if (query.get("type") !== "note")
          return HttpResponse.json({
            ...projectItems([{ product: trail, items: [todoRow()] }]),
            counts,
          });
        if (revoked && query.get("status") === "current") await held;
        return HttpResponse.json({
          ...projectItems(
            revoked
              ? [{ product: trail, items: [noteRow()] }]
              : [{ product: openBot, items: [revokedNote] }],
          ),
          counts,
        });
      }),
    );
    const { router, queryClient } = renderApp("/projects/human-ui");
    expect(
      await within(
        await screen.findByRole("region", { name: /^Notes/ }),
      ).findByText(revokedNote.title),
    ).toBeVisible();
    const stream = FakeEventSource.current;
    stream.open();
    await router.navigate({
      to: "/projects/$slug",
      params: { slug: "human-ui" },
      search: { type: "note" },
    });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    revoked = true;
    act(() => {
      stream.dispatchEvent(new MessageEvent("access", { data: "{}" }));
    });
    expect(await screen.findAllByText(noteRow().title)).not.toHaveLength(0);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    const shown = watchFor(reading(revokedNote.title));
    await router.navigate({
      to: "/projects/$slug",
      params: { slug: "human-ui" },
      search: {},
    });
    await screen.findByRole("region", { name: /^Notes/ });
    release();
    expect(
      await within(screen.getByRole("region", { name: /^Notes/ })).findByText(
        noteRow().title,
      ),
    ).toBeVisible();
    expect(shown()).toBe(false);
  });
});

describe("pages", () => {
  test("a group split across pages is one group, and later groups are drawn", async () => {
    signedInAs("member");
    serveProject();
    const cursors: (string | null)[] = [];
    server.use(
      http.get("/api/web/projects/human-ui/items", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        const first = projectItems([
          { product: openBot, items: [issueRow({ key: "OPB-3" })] },
        ]);
        const second = projectItems([
          {
            product: openBot,
            items: [issueRow({ key: "OPB-1", title: "Continued row" })],
          },
          { product: trail, items: [todoRow()] },
        ]);
        // the server's count is the group's whole total on every page
        const page = cursor ? second : first;
        return HttpResponse.json({
          ...page,
          groups: page.groups.map((g) => ({
            ...g,
            count: g.product.key === openBot.key ? 2 : 1,
          })),
          nextCursor: cursor ? null : "after-opb-3",
        });
      }),
    );
    renderApp("/projects/human-ui");
    expect(await screen.findAllByText(todoRow().title)).not.toHaveLength(0);
    expect(screen.getAllByText("Continued row")).not.toHaveLength(0);
    expect(cursors).toEqual([null, "after-opb-3"]);
    // as many openBot headers ("2 issues and todos") as trail ones ("1 issue or todo"): one per layout, not per page
    expect(screen.getAllByText("2 issues and todos")).toHaveLength(
      screen.getAllByText("1 issue or todo").length,
    );
  });

  test("past the page cap the page says rows are missing", async () => {
    signedInAs("member");
    serveProject();
    let asked = 0;
    server.use(
      http.get("/api/web/projects/human-ui/items", () => {
        asked++;
        const row = issueRow({ key: `OPB-${asked}`, title: `Row ${asked}` });
        return HttpResponse.json({
          ...projectItems([
            { product: openBot, items: [row] },
            { product: trail, items: [todoRow({ key: `TRL-${asked}` })] },
          ]),
          nextCursor: `after-${asked}`,
        });
      }),
    );
    renderApp("/projects/human-ui");
    // two rows a page, one per product
    expect(
      await screen.findAllByText("Only the first 20 items are shown."),
    ).not.toHaveLength(0);
    expect(asked).toBe(ITEM_PAGES_MAX);
  });
});

describe("old product links", () => {
  test("/projects/TRL is the TRL product, filters and all", async () => {
    signedInAs("member");
    server.use(
      http.get("/api/web/products/TRL", notFound),
      http.get("/api/web/products/TRL/items", notFound),
      http.get("/api/web/products/TRL/status-updates", notFound),
    );
    const { router } = renderApp("/projects/TRL?status=done");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/products/TRL"),
    );
    expect(router.state.location.search).toEqual({ status: "done" });
    // the product page's own reads, answered before the test ends
    await screen.findByRole("heading", { name: "Page not found", level: 1 });
  });
  test("/projects/trl, no such project, is the TRL product in place, with its filters", async () => {
    signedInAs("member");
    server.use(
      http.get("/api/web/projects/trl", notFound),
      http.get("/api/web/projects/trl/items", notFound),
      http.get("/api/web/projects/trl/status-updates", notFound),
      http.get("/api/web/products/TRL", notFound),
      http.get("/api/web/products/TRL/items", notFound),
      http.get("/api/web/products/TRL/status-updates", notFound),
    );
    const { router } = renderApp(
      "/projects/trl?status=done&type=todo&product=OPB",
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/products/TRL"),
    );
    expect(router.state.location.search).toEqual({
      status: "done",
      type: "todo",
    });
    expect(router.history.length).toBe(1);
    await screen.findByRole("heading", { name: "Page not found", level: 1 });
  });

  test("a project named like a product is the project", async () => {
    signedInAs("member");
    server.use(
      http.get("/api/web/projects/trl", () =>
        HttpResponse.json(projectDetail()),
      ),
      http.get("/api/web/projects/trl/items", () =>
        HttpResponse.json(
          projectItems([{ product: trail, items: [todoRow()] }]),
        ),
      ),
      http.get("/api/web/projects/trl/status-updates", () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const { router } = renderApp("/projects/trl");
    expect(await screen.findAllByText(todoRow().title)).not.toHaveLength(0);
    expect(router.state.location.pathname).toBe("/projects/trl");
  });
});

describe("not found", () => {
  async function notFoundMarkup(path: string) {
    signedInAs("member");
    server.use(
      http.get("/api/web/projects/:slug", notFound),
      http.get("/api/web/projects/:slug/items", notFound),
      http.get("/api/web/projects/:slug/status-updates", notFound),
    );
    renderApp(path);
    await screen.findByRole("heading", { name: "Page not found", level: 1 });
    const markup = document.body.innerHTML.replace(/_r_\w+_/g, "_id_");
    cleanup();
    return markup;
  }

  test("a project the server won't show renders the same page as an unknown URL", async () => {
    const unknown = await notFoundMarkup("/no-such-page");
    expect(await notFoundMarkup("/projects/secret-launch")).toBe(unknown);
  });

  test("/projects/sec, a product the viewer can't see, is the same page as one that doesn't exist", async () => {
    const unknown = await notFoundMarkup("/projects/zzz");
    expect(await notFoundMarkup("/projects/sec")).toBe(unknown);
  });
});
