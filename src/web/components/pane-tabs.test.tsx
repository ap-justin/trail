import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Pane, PaneTabs } from "@/components/pane-tabs";
import { Tabs } from "@/components/ui/tabs";

const panes = [
  ["items", "Items"],
  ["updates", "Status updates"],
] as const;

function renderPanes() {
  render(
    <Tabs value="items">
      <PaneTabs panes={panes} />
      <Pane value="items">
        <p>The items</p>
      </Pane>
      <Pane value="updates">
        <p>The updates</p>
      </Pane>
    </Tabs>,
  );
}

const desktop = () =>
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches: query === "(min-width: 1024px)",
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("panes", () => {
  test("below 1024px each pane is a tab panel named by its tab", () => {
    renderPanes();
    expect(screen.getByRole("tabpanel", { name: "Items" })).toHaveTextContent(
      "The items",
    );
  });

  test("at 1024px, with the tab strip gone, a pane is no tab panel and no tab stop", () => {
    desktop();
    renderPanes();
    expect(screen.queryAllByRole("tabpanel", { hidden: true })).toEqual([]);
    for (const text of ["The items", "The updates"]) {
      const pane = screen.getByText(text).parentElement;
      expect(pane).not.toHaveAttribute("tabindex");
      expect(pane).not.toHaveAttribute("aria-labelledby");
    }
  });
});
