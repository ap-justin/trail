import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { notFound, renderApp, signedInAs } from "@/test/app";
import {
  issueList,
  issueRow,
  project,
  statusUpdate,
  trail,
} from "@/test/fixtures";
import { server } from "@/test/server";

/** Answers TRL's reads, recording the status each issue-list request asked for. */
function serveProject() {
  const statuses: (string | null)[] = [];
  server.use(
    http.get("/api/web/projects/TRL", () => HttpResponse.json(project())),
    http.get("/api/web/projects/TRL/issues", ({ request }) => {
      statuses.push(new URL(request.url).searchParams.get("status"));
      return HttpResponse.json(issueList([issueRow()]));
    }),
    http.get("/api/web/projects/TRL/status-updates", () =>
      HttpResponse.json({ items: [statusUpdate()], nextCursor: null }),
    ),
  );
  return statuses;
}

const selectedTab = () =>
  screen.getByRole("tab", { selected: true }).textContent;

describe("project page", () => {
  test("?status= picks the tab and the request", async () => {
    signedInAs("member");
    const statuses = serveProject();
    renderApp("/projects/TRL?status=in_progress");
    expect(
      await screen.findAllByText("Human UI: feed, projects, issue page"),
    ).not.toHaveLength(0);
    expect(statuses).toEqual(["in_progress"]);
    expect(selectedTab()).toMatch(/^In progress/);
  });

  test("an unknown status falls back to All", async () => {
    signedInAs("member");
    const statuses = serveProject();
    renderApp("/projects/TRL?status=bogus");
    expect(
      await screen.findAllByText("Human UI: feed, projects, issue page"),
    ).not.toHaveLength(0);
    expect(statuses).toEqual([null]);
    expect(selectedTab()).toMatch(/^All/);
  });

  test("clicking a tab puts it in the URL and asks for it", async () => {
    signedInAs("member");
    const statuses = serveProject();
    const { router } = renderApp("/projects/TRL");
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

describe("links", () => {
  test("an issue row's link is described by its meta line", async () => {
    signedInAs("member");
    serveProject();
    renderApp("/projects/TRL");
    const links = await screen.findAllByRole("link", {
      name: "TRL-17 Human UI: feed, projects, issue page",
    });
    // the 375 list's row; the 1440 table names its row by cells instead
    const row = links.find((link) => link.closest("ul"));
    expect(row).toHaveAccessibleDescription(/Tara/);
  });

  test("a link to the page you're on carries only the component's own aria-current", async () => {
    signedInAs("member");
    serveProject();
    server.use(
      http.get("/api/web/search", () =>
        HttpResponse.json({ issues: [], projects: [trail] }),
      ),
    );
    renderApp("/projects/TRL");
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
      http.get("/api/web/projects/:key", notFound),
      http.get("/api/web/projects/:key/issues", notFound),
      http.get("/api/web/projects/:key/status-updates", notFound),
      http.get("/api/web/issues/:key", notFound),
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
    expect(await notFoundMarkup("/projects/SEC")).toBe(unknown);
    expect(await notFoundMarkup("/issues/SEC-1")).toBe(unknown);
  });
});
