import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { SearchResults } from "@/components/search-results";

const results = {
  products: [{ key: "TRL", name: "trail" }],
  projects: [{ slug: "human-ui", name: "Human UI launch" }],
  items: [
    {
      key: "TRL-14",
      sourceKey: "OLD-187",
      title: "Team access: invite people",
      type: "issue" as const,
      status: "in_progress" as const,
      product: { key: "TRL", name: "trail" },
    },
  ],
};

describe("SearchResults", () => {
  test("products, projects and items as links: products by name and key, projects by name, items by status and type glyph", () => {
    render(
      <SearchResults
        query="team"
        answeredQuery="team"
        results={results}
        status="ready"
      />,
    );
    const [product, project, issue] = within(
      screen.getByRole("list", { name: "Search results" }),
    ).getAllByRole("link");
    expect(product).toHaveAttribute("href", "/products/TRL");
    expect(product).toHaveAccessibleName("trail TRL");
    expect(product?.lastElementChild).toHaveAttribute("data-key-pill");
    expect(product?.lastElementChild).toHaveTextContent(/^TRL$/);
    // an issue key stays plain mono text, not a pill
    expect(issue?.querySelector("[data-key-pill]")).toBeNull();
    expect(product?.querySelector("svg")).toHaveClass("lucide-package");
    expect(project).toHaveAttribute("href", "/projects/human-ui");
    expect(project).toHaveAccessibleName("Human UI launch");
    expect(project?.querySelector("svg")).toHaveClass("lucide-folder");
    expect(issue).toHaveAttribute("href", "/products/TRL/14");
    expect(issue).toHaveAccessibleName(
      "TRL-14 Team access: invite people OLD-187",
    );
    // every item row leads with the same two glyphs, so keys line up whatever the type
    expect(
      [...(issue?.querySelectorAll("svg") ?? [])].map(
        (svg) => svg.dataset.itemType ?? null,
      ),
    ).toEqual([null, "issue"]);
  });

  test("a note's row carries its status glyph and the Note glyph, and says it's a note; an archived one says so and looks it", () => {
    const note = {
      sourceKey: null,
      type: "note" as const,
      product: { key: "TRL", name: "trail" },
    };
    render(
      <SearchResults
        query="deploy"
        answeredQuery="deploy"
        results={{
          products: [],
          projects: [],
          items: [
            {
              ...note,
              key: "TRL-31",
              title: "How a deploy reaches the volume",
              status: "current",
            },
            {
              ...note,
              key: "TRL-29",
              title: "Old deploy steps",
              status: "archived",
            },
          ],
        }}
        status="ready"
      />,
    );
    const glyphs = (link: HTMLElement) =>
      [...link.querySelectorAll("svg")].map(
        (svg) => svg.dataset.itemType ?? svg.getAttribute("class"),
      );
    const current = screen.getByRole("link", {
      name: "Note TRL-31 How a deploy reaches the volume",
    });
    const archived = screen.getByRole("link", {
      name: "Archived note TRL-29 Old deploy steps",
    });
    expect(glyphs(current)).toEqual([
      expect.stringContaining("lucide-bookmark"),
      "note",
    ]);
    expect(glyphs(archived)).toEqual([
      expect.stringContaining("lucide-archive"),
      "note",
    ]);
  });

  test("none: the empty state", () => {
    render(
      <SearchResults
        query="team"
        answeredQuery="team"
        results={{ products: [], projects: [], items: [] }}
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
    expect(region).toHaveTextContent("3 results");

    rerender(
      <SearchResults
        {...props}
        results={{ products: [], projects: [], items: [] }}
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
        results={{ products: [], projects: [], items: results.items }}
        status="ready"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/^1 result$/);
  });
});
