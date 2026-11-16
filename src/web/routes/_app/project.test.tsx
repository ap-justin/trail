import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { ITEM_PAGES_MAX } from "@/lib/queries";
import { notFound, renderApp, signedInAs } from "@/test/app";
import {
  issueRow,
  openBot,
  projectDetail,
  projectItems,
  statusUpdate,
  todoRow,
  trail,
} from "@/test/fixtures";
import { server } from "@/test/server";

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
    // as many openBot headers ("2 items") as trail ones ("1 item"): one per layout, not per page
    expect(screen.getAllByText("2 items")).toHaveLength(
      screen.getAllByText("1 item").length,
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
});
