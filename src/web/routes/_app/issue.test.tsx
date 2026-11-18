import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import type { EntryView, WebItemView } from "@/lib/api-types";
import { notFound, renderApp, signedInAs } from "@/test/app";
import { issue, issueList, maya, product, trail } from "@/test/fixtures";
import { server } from "@/test/server";

function serveIssue() {
  server.use(
    http.get("/api/web/items/TRL-14", () => HttpResponse.json(issue())),
  );
}

describe("issue page shell", () => {
  test("links back to its product and marks that product's row as where it sits", async () => {
    signedInAs("member");
    serveIssue();
    renderApp("/products/TRL/14");
    expect(
      await screen.findByRole("link", { name: "Back to trail" }),
    ).toHaveAttribute("href", "/products/TRL");
    const products = screen.getByRole("navigation", { name: "Products" });
    expect(
      within(products).getByRole("link", { name: "trail TRL" }),
    ).toHaveAttribute("aria-current", "location");
  });

  test("the breadcrumb is a nav, so the title is the page's one h1", async () => {
    signedInAs("member");
    serveIssue();
    renderApp("/products/TRL/14");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Team access: invite people by GitHub username",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getAllByRole("navigation", { name: "Breadcrumb" }),
    ).not.toEqual([]);
  });
});

describe("old links", () => {
  test("/issues/TRL-14 goes to the item's own URL", async () => {
    signedInAs("member");
    serveIssue();
    const { router } = renderApp("/issues/TRL-14");
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Team access: invite people by GitHub username",
      }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/products/TRL/14");
  });

  test("/issues/OLD-187, an imported item's source key, lands on the item's own key in place", async () => {
    signedInAs("member");
    const imported = issue({ key: "TRL-5", sourceKey: "OLD-187" });
    server.use(
      http.get("/api/web/items/OLD-187", () => HttpResponse.json(imported)),
      http.get("/api/web/items/TRL-5", () => HttpResponse.json(imported)),
    );
    const { router } = renderApp("/issues/OLD-187");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/products/TRL/5"),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: imported.title }),
    ).toBeInTheDocument();
    // every hop replaced the entry before it, so Back leaves the item
    expect(router.history.length).toBe(1);
  });

  test.each([
    "/issues/trl-14",
    "/issues/TRL-014",
    "/products/trl/14",
    "/products/TRL/014",
  ])("%s is spelled as the item's own key", async (path) => {
    signedInAs("member");
    server.use(
      http.get("/api/web/items/:key", ({ params }) =>
        String(params.key).toUpperCase().replace(/-0+/, "-") === "TRL-14"
          ? HttpResponse.json(issue())
          : notFound(),
      ),
    );
    const { router } = renderApp(path);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/products/TRL/14"),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: issue().title }),
    ).toBeInTheDocument();
    expect(router.history.length).toBe(1);
  });

  test("a number that isn't one is Not found, and nothing is read", async () => {
    signedInAs("member");
    const asked: string[] = [];
    server.use(
      http.get("/api/web/items/:key", ({ params }) => {
        asked.push(String(params.key));
        return notFound();
      }),
    );
    renderApp("/products/TRL/abc");
    expect(
      await screen.findByRole("heading", { name: "Page not found", level: 1 }),
    ).toBeInTheDocument();
    expect(asked).toEqual([]);
  });
});

describe("filing an issue", () => {
  test("New issue on a product page files in that product and goes to the new issue", async () => {
    signedInAs("member");
    server.use(
      http.get("/api/web/products/DOC", () =>
        HttpResponse.json(product({ key: "DOC", name: "Docs site" })),
      ),
      http.get("/api/web/products/DOC/items", () =>
        HttpResponse.json(issueList([])),
      ),
      http.get("/api/web/products/DOC/status-updates", () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const filed = () =>
      issue({
        key: "DOC-3",
        title: "Write the guide",
        product: { key: "DOC", name: "Docs site" },
      });
    const sent: unknown[] = [];
    server.use(
      http.post("/api/web/issues", async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json(filed(), { status: 201 });
      }),
      http.get("/api/web/items/DOC-3", () => HttpResponse.json(filed())),
    );
    const { router } = renderApp("/products/DOC");
    const [newIssue] = await screen.findAllByRole("button", {
      name: "New issue",
    });
    if (!newIssue) throw new Error("no New issue button");
    await userEvent.click(newIssue);
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByLabelText("Title"),
      "Write the guide",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create issue" }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/products/DOC/3"),
    );
    expect(sent).toEqual([
      { product: "DOC", title: "Write the guide", description: "" },
    ]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Write the guide" }),
    ).toBeInTheDocument();
  });

  test("a failed create shows the server's message in the dialog", async () => {
    signedInAs("member");
    serveIssue();
    server.use(
      http.post("/api/web/issues", () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "No such project: TRL" } },
          { status: 404 },
        ),
      ),
    );
    renderApp("/products/TRL/14");
    await screen.findByRole("heading", { name: issue().title });
    const [newIssue] = screen.getAllByRole("button", { name: "New issue" });
    if (!newIssue) throw new Error("no New issue button");
    await userEvent.click(newIssue);
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Title"), "Another");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create issue" }),
    );
    expect(
      await within(dialog).findByText("No such project: TRL"),
    ).toBeInTheDocument();
  });
});

describe("commenting", () => {
  test("Comment is held while empty; a posted comment appends to the timeline as the human", async () => {
    signedInAs("member");
    serveIssue();
    const sent: unknown[] = [];
    server.use(
      http.post("/api/web/items/TRL-14/comments", async ({ request }) => {
        sent.push(await request.json());
        const entry: EntryView = {
          kind: "comment",
          id: "t9",
          createdAt: "2026-11-11T12:00:00.000Z",
          actor: maya,
          product: trail,
          project: null,
          item: { key: "TRL-14", title: issue().title, type: "issue" },
          comment: { id: "c9", body: "Ship it.", sourceAuthor: null },
        };
        return HttpResponse.json(entry, { status: 201 });
      }),
    );
    renderApp("/products/TRL/14");
    const button = await screen.findByRole("button", { name: "Comment" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(
      screen.getByRole("textbox", { name: "Comment" }),
      "Ship it.",
    );
    await userEvent.click(button);
    expect(await screen.findAllByText("Ship it.")).not.toHaveLength(0);
    expect(sent).toEqual([{ body: "Ship it." }]);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue(""),
    );
  });

  test("a comment that answers after the viewer opened another issue lands on its own issue only", async () => {
    signedInAs("member");
    serveIssue();
    server.use(
      http.get("/api/web/items/TRL-15", () =>
        HttpResponse.json(
          issue({ key: "TRL-15", title: "Search", timeline: [] }),
        ),
      ),
    );
    let answer: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    server.use(
      http.post("/api/web/items/TRL-14/comments", async () => {
        await answered;
        const entry: EntryView = {
          kind: "comment",
          id: "t9",
          createdAt: "2026-11-11T12:00:00.000Z",
          actor: maya,
          product: trail,
          project: null,
          item: { key: "TRL-14", title: issue().title, type: "issue" },
          comment: { id: "c9", body: "Ship it.", sourceAuthor: null },
        };
        return HttpResponse.json(entry, { status: 201 });
      }),
    );
    const { router, queryClient } = renderApp("/products/TRL/14");
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Comment" }),
      "Ship it.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    await router.navigate({
      to: "/products/$key/$n",
      params: { key: "TRL", n: "15" },
    });
    expect(await screen.findByText("Search")).toBeInTheDocument();
    // the new issue starts with an empty draft and no write in flight
    const box = screen.getByRole("textbox", { name: "Comment" });
    expect(box).toHaveValue("");
    await userEvent.type(box, "Next");
    expect(screen.getByRole("button", { name: "Comment" })).toBeEnabled();
    answer();
    await waitFor(() =>
      expect(
        queryClient
          .getQueryData<WebItemView>(["issue", "TRL-14"])
          ?.timeline.some((e) => e.id === "t9"),
      ).toBe(true),
    );
    expect(
      queryClient.getQueryData<WebItemView>(["issue", "TRL-15"])?.timeline,
    ).toEqual([]);
    expect(screen.queryByText("Ship it.")).not.toBeInTheDocument();
  });

  test("a failed comment shows the server's message and keeps the text", async () => {
    signedInAs("member");
    serveIssue();
    server.use(
      http.post("/api/web/items/TRL-14/comments", () =>
        HttpResponse.json(
          { error: { code: "too_large", message: "Comment is too long" } },
          { status: 413 },
        ),
      ),
    );
    renderApp("/products/TRL/14");
    const box = await screen.findByRole("textbox", { name: "Comment" });
    await userEvent.type(box, "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText("Comment is too long")).toBeInTheDocument();
    expect(box).toHaveValue("Hello");
  });
});
