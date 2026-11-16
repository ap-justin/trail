import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
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
