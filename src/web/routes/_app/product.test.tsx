import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { ITEM_PAGES_MAX } from "@/lib/queries";
import { notFound, renderApp, signedInAs } from "@/test/app";
import {
  issueList,
  issueRow,
  itemList,
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
