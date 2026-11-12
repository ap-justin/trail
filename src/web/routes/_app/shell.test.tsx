import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SearchView } from "@/lib/api-types";
import { renderApp, serveFeed, signedInAs } from "@/test/app";
import { installFakeEventSource } from "@/test/event-source";
import { issueList, project, trail } from "@/test/fixtures";
import { server } from "@/test/server";

installFakeEventSource();
afterEach(() => {
  vi.restoreAllMocks();
});

function serveSearch(answer: SearchView) {
  const asked: string[] = [];
  server.use(
    http.get("/api/web/search", ({ request }) => {
      asked.push(new URL(request.url).searchParams.get("q") ?? "");
      return HttpResponse.json(answer);
    }),
  );
  return asked;
}

const searchBox = () =>
  screen.getAllByRole("searchbox", { name: "Search issues" })[0] as HTMLElement;

describe("search", () => {
  test("asks once the typing settles and lists the hits as links", async () => {
    signedInAs("member");
    serveFeed();
    const asked = serveSearch({
      issues: [
        {
          key: "TRL-14",
          sourceKey: null,
          title: "Team access",
          status: "open",
          project: trail,
        },
      ],
      projects: [],
    });
    renderApp("/");
    await screen.findByText("No activity yet");
    await userEvent.type(searchBox(), "team");
    const results = await screen.findByRole("list", { name: "Search results" });
    expect(results).toHaveTextContent("TRL-14Team access");
    expect(asked).toEqual(["team"]);
  });

  test("following a result empties the box and closes the results", async () => {
    signedInAs("member");
    serveFeed();
    serveSearch({ issues: [], projects: [trail] });
    server.use(
      http.get("/api/web/projects/TRL", () => HttpResponse.json(project())),
      http.get("/api/web/projects/TRL/issues", () =>
        HttpResponse.json(issueList([])),
      ),
      http.get("/api/web/projects/TRL/status-updates", () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
    );
    const { router } = renderApp("/");
    await screen.findByText("No activity yet");
    await userEvent.type(searchBox(), "tra");
    const results = await screen.findByRole("list", { name: "Search results" });
    await userEvent.click(within(results).getByRole("link"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/projects/TRL"),
    );
    expect(searchBox()).toHaveValue("");
    expect(
      screen.queryByRole("list", { name: "Search results" }),
    ).not.toBeInTheDocument();
  });

  test("a failed search says so in the panel", async () => {
    signedInAs("member");
    serveFeed();
    server.use(
      http.get(
        "/api/web/search",
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    renderApp("/");
    await screen.findByText("No activity yet");
    await userEvent.type(searchBox(), "x");
    expect(
      await screen.findByRole("heading", { name: "Couldn't search" }),
    ).toBeInTheDocument();
  });

  test("no hits shows the empty state", async () => {
    signedInAs("member");
    serveFeed();
    serveSearch({ issues: [], projects: [] });
    renderApp("/");
    await screen.findByText("No activity yet");
    await userEvent.type(searchBox(), "zzz");
    expect(
      await screen.findByRole("heading", { name: "No results" }),
    ).toBeInTheDocument();
  });
});

describe("account", () => {
  test("/account shows the account panel below the desktop layout", async () => {
    signedInAs("member");
    renderApp("/account");
    expect(
      await screen.findByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Theme" })).toBeInTheDocument();
  });

  test("/account at desktop width goes to the feed", async () => {
    signedInAs("member");
    serveFeed();
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: query === "(min-width: 1024px)",
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    const { router } = renderApp("/account");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });
});
