import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import {
  FilterEmpty,
  GroupHeading,
  type ItemFilters,
} from "@/components/item-list";
import { trail } from "@/test/fixtures";

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

  test("Show all calls back", async () => {
    const onShowAll = renderEmpty({ type: null, status: "open" });
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onShowAll).toHaveBeenCalledOnce();
  });
});

describe("GroupHeading", () => {
  test.each([
    [1, "trail TRL 1 issue or todo"],
    [8, "trail TRL 8 issues and todos"],
  ])("%i under All names issues and todos, not items", (count, text) => {
    const { container } = render(
      <GroupHeading product={trail} count={count} type={null} />,
    );
    expect(container).toHaveTextContent(text);
  });

  test.each([
    ["issue", 1, "trail TRL 1 issue"],
    ["issue", 8, "trail TRL 8 issues"],
    ["todo", 1, "trail TRL 1 todo"],
    ["todo", 8, "trail TRL 8 todos"],
    ["note", 1, "trail TRL 1 note"],
    ["note", 8, "trail TRL 8 notes"],
  ] as const)("a %s filter names its own type, %i", (type, count, text) => {
    const { container } = render(
      <GroupHeading product={trail} count={count} type={type} />,
    );
    // exact: "8 issues" alone would also match "8 issues and todos"
    expect(container.textContent?.replace(/\s+/g, " ").trim()).toBe(text);
  });
});
