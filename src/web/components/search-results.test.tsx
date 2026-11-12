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
    render(<SearchResults results={results} status="ready" />);
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
      <SearchResults results={{ projects: [], issues: [] }} status="ready" />,
    );
    expect(
      screen.getByRole("heading", { name: "No results" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  test("loading and error draw no links", () => {
    const { rerender } = render(
      <SearchResults results={null} status="loading" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    rerender(<SearchResults results={results} status="error" />);
    expect(
      screen.getByRole("heading", { name: "Couldn't search" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
