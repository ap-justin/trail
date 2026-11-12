import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SearchResults } from "@/components/search-results";

const results = {
  projects: [{ key: "TRL", name: "trail" }],
  issues: [
    {
      key: "TRL-14",
      sourceKey: "JUS-187",
      title: "Team access: invite people",
      status: "in_progress" as const,
      project: { key: "TRL", name: "trail" },
    },
  ],
};

describe("SearchResults", () => {
  test("projects and issues as links, each with its key and title", () => {
    render(
      <SearchResults
        query="team"
        answeredQuery="team"
        results={results}
        status="ready"
      />,
    );
    const [project, issue] = within(
      screen.getByRole("list", { name: "Search results" }),
    ).getAllByRole("link");
    expect(project).toHaveAttribute("href", "/projects/TRL");
    expect(project).toHaveAccessibleName("TRL trail");
    expect(issue).toHaveAttribute("href", "/issues/TRL-14");
    expect(issue).toHaveAccessibleName(
      "TRL-14 Team access: invite people JUS-187",
    );
  });

  test("none: the empty state", () => {
    render(
      <SearchResults
        query="team"
        answeredQuery="team"
        results={{ projects: [], issues: [] }}
        status="ready"
      />,
    );
    expect(
      screen.getByRole("heading", { name: "No results" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("loading and error draw no links", () => {
    const { rerender } = render(
      <SearchResults
        query="team"
        answeredQuery="team"
        results={null}
        status="loading"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    rerender(
      <SearchResults
        query="team"
        answeredQuery="team"
        results={results}
        status="error"
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Couldn't search" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("results for an earlier query are never shown under a new one: loading instead", () => {
    // "auth" answered, Escape, then "deploy" typed before the debounce lands
    render(
      <SearchResults
        query="deploy"
        answeredQuery="auth"
        results={results}
        status="ready"
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });

  test("a failure for an earlier query reads as loading, not as this query failing", () => {
    render(
      <SearchResults
        query="deploy"
        answeredQuery="auth"
        results={null}
        status="error"
      />,
    );
    expect(
      screen.queryByRole("heading", { name: "Couldn't search" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });

  test("one live region announces each outcome as it replaces loading", () => {
    const props = { query: "team", answeredQuery: "team" };
    const { rerender } = render(
      <SearchResults {...props} results={null} status="loading" />,
    );
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("Loading");

    rerender(<SearchResults {...props} results={results} status="ready" />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("2 results");

    rerender(
      <SearchResults
        {...props}
        results={{ projects: [], issues: [] }}
        status="ready"
      />,
    );
    expect(region).toHaveTextContent("No results");

    rerender(<SearchResults {...props} results={null} status="error" />);
    expect(region).toHaveTextContent("Couldn't search");
  });

  test("a single hit is announced in the singular", () => {
    render(
      <SearchResults
        query="team"
        answeredQuery="team"
        results={{ projects: [], issues: results.issues }}
        status="ready"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/^1 result$/);
  });
});
