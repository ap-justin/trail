import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import type { EntryView, WebIssueView } from "@/lib/api-types";
import { renderApp, signedInAs } from "@/test/app";
import { issue, issueList, maya, project, trail } from "@/test/fixtures";
import { server } from "@/test/server";

function serveIssue() {
  server.use(
    http.get("/api/web/issues/TRL-14", () => HttpResponse.json(issue())),
  );
}

describe("issue page shell", () => {
  test("links back to its project and marks that project's row as where it sits", async () => {
    signedInAs("member");
    serveIssue();
    renderApp("/issues/TRL-14");
    expect(
      await screen.findByRole("link", { name: "Back to trail" }),
    ).toHaveAttribute("href", "/projects/TRL");
    const projects = screen.getByRole("navigation", { name: "Projects" });
    expect(
      within(projects).getByRole("link", { name: "TRL trail" }),
    ).toHaveAttribute("aria-current", "location");
  });
});

describe("filing an issue", () => {
  test("New issue on a project page files in that project and goes to the new issue", async () => {
    signedInAs("member");
    server.use(
      http.get("/api/web/projects/DOC", () =>
        HttpResponse.json(project({ key: "DOC", name: "Docs site" })),
      ),
      http.get("/api/web/projects/DOC/issues", () =>
        HttpResponse.json(issueList([])),
      ),
      http.get("/api/web/projects/DOC/status-updates", () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const filed = () =>
      issue({
        key: "DOC-3",
        title: "Write the guide",
        project: { key: "DOC", name: "Docs site" },
      });
    const sent: unknown[] = [];
    server.use(
      http.post("/api/web/issues", async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json(filed(), { status: 201 });
      }),
      http.get("/api/web/issues/DOC-3", () => HttpResponse.json(filed())),
    );
    const { router } = renderApp("/projects/DOC");
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
      expect(router.state.location.pathname).toBe("/issues/DOC-3"),
    );
    expect(sent).toEqual([
      { projectKey: "DOC", title: "Write the guide", description: "" },
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
    renderApp("/issues/TRL-14");
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
  test("Comment is disabled while empty; a posted comment appends to the timeline as the human", async () => {
    signedInAs("member");
    serveIssue();
    const sent: unknown[] = [];
    server.use(
      http.post("/api/web/issues/TRL-14/comments", async ({ request }) => {
        sent.push(await request.json());
        const entry: EntryView = {
          kind: "comment",
          id: "t9",
          createdAt: "2026-11-11T12:00:00.000Z",
          actor: maya,
          project: trail,
          issue: { key: "TRL-14", title: issue().title },
          comment: { id: "c9", body: "Ship it.", sourceAuthor: null },
        };
        return HttpResponse.json(entry, { status: 201 });
      }),
    );
    renderApp("/issues/TRL-14");
    const button = await screen.findByRole("button", { name: "Comment" });
    expect(button).toBeDisabled();
    await userEvent.type(
      screen.getByPlaceholderText("Leave a comment. Markdown works."),
      "Ship it.",
    );
    await userEvent.click(button);
    expect(await screen.findAllByText("Ship it.")).not.toHaveLength(0);
    expect(sent).toEqual([{ body: "Ship it." }]);
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("Leave a comment. Markdown works."),
      ).toHaveValue(""),
    );
  });

  test("a comment that answers after the viewer opened another issue lands on its own issue only", async () => {
    signedInAs("member");
    serveIssue();
    server.use(
      http.get("/api/web/issues/TRL-15", () =>
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
      http.post("/api/web/issues/TRL-14/comments", async () => {
        await answered;
        const entry: EntryView = {
          kind: "comment",
          id: "t9",
          createdAt: "2026-11-11T12:00:00.000Z",
          actor: maya,
          project: trail,
          issue: { key: "TRL-14", title: issue().title },
          comment: { id: "c9", body: "Ship it.", sourceAuthor: null },
        };
        return HttpResponse.json(entry, { status: 201 });
      }),
    );
    const { router, queryClient } = renderApp("/issues/TRL-14");
    await userEvent.type(
      await screen.findByPlaceholderText("Leave a comment. Markdown works."),
      "Ship it.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    await router.navigate({ to: "/issues/$key", params: { key: "TRL-15" } });
    expect(await screen.findByText("Search")).toBeInTheDocument();
    // the new issue starts with an empty draft and no write in flight
    const box = screen.getByPlaceholderText("Leave a comment. Markdown works.");
    expect(box).toHaveValue("");
    await userEvent.type(box, "Next");
    expect(screen.getByRole("button", { name: "Comment" })).toBeEnabled();
    answer();
    await waitFor(() =>
      expect(
        queryClient
          .getQueryData<WebIssueView>(["issue", "TRL-14"])
          ?.timeline.some((e) => e.id === "t9"),
      ).toBe(true),
    );
    expect(
      queryClient.getQueryData<WebIssueView>(["issue", "TRL-15"])?.timeline,
    ).toEqual([]);
    expect(screen.queryByText("Ship it.")).not.toBeInTheDocument();
  });

  test("a failed comment shows the server's message and keeps the text", async () => {
    signedInAs("member");
    serveIssue();
    server.use(
      http.post("/api/web/issues/TRL-14/comments", () =>
        HttpResponse.json(
          { error: { code: "too_large", message: "Comment is too long" } },
          { status: 413 },
        ),
      ),
    );
    renderApp("/issues/TRL-14");
    const box = await screen.findByPlaceholderText(
      "Leave a comment. Markdown works.",
    );
    await userEvent.type(box, "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText("Comment is too long")).toBeInTheDocument();
    expect(box).toHaveValue("Hello");
  });
});
