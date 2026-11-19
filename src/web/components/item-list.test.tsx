import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { FilterEmpty, type ItemFilters } from "@/components/item-list";

function renderEmpty(filters: ItemFilters) {
  const onShowAll = vi.fn();
  render(<FilterEmpty filters={filters} onShowAll={onShowAll} />);
  return onShowAll;
}

describe("FilterEmpty", () => {
  // notes sit below the All list, so "items" would deny the notes on screen
  test("All with a status names issues and todos, not items", () => {
    renderEmpty({ type: null, status: "open" });
    expect(
      screen.getByRole("heading", { name: "No issues or todos are open" }),
    ).toBeInTheDocument();
  });

  test("All without a status names issues and todos, not items", () => {
    renderEmpty({ type: null, status: null });
    expect(
      screen.getByRole("heading", { name: "No issues or todos yet" }),
    ).toBeInTheDocument();
  });

  test.each([
    ["issue", "No issues are done"],
    ["todo", "No todos are done"],
  ] as const)("a %s filter keeps its own noun", (type, name) => {
    renderEmpty({ type, status: "done" });
    expect(screen.getByRole("heading", { name })).toBeInTheDocument();
  });

  test("Show all hands every filter back", async () => {
    const onShowAll = renderEmpty({ type: null, status: "open" });
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onShowAll).toHaveBeenCalledOnce();
  });
});
