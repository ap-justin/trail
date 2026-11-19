import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import {
  type ItemFilters,
  matchesFilters,
  NO_FILTERS,
} from "@/components/item-list";
import {
  ProductHeading,
  ProductView,
  type ProductViewProps,
} from "@/components/product";
import { priorityLabel } from "@/components/status";
import {
  beta,
  countsOf,
  issueRow,
  itemList,
  noteRow,
  productDetail,
  projectRow,
  statusUpdate,
  todoRow,
  trail,
} from "@/test/fixtures";

const now = new Date("2026-11-11T12:00:00.000Z");

const rows = [
  todoRow(),
  issueRow(),
  issueRow({
    key: "TRL-11",
    title: "Board view for the issue list",
    status: "canceled",
    priority: 0,
    labels: [],
    assignee: null,
  }),
  todoRow({
    key: "TRL-15",
    title: "Back up the volume with Litestream",
    status: "in_progress",
  }),
];

function props(overrides: Partial<ProductViewProps> = {}): ProductViewProps {
  const items: ProductViewProps["items"] = overrides.items ?? {
    status: "ready",
    data: itemList(rows),
  };
  return {
    // the route's: the last list's
    noteCounts: items.status === "ready" ? items.data.counts.notes : null,
    product: trail,
    detail: productDetail(),
    items,
    notes: { status: "ready", data: [] },
    statusUpdates: {
      status: "ready",
      data: { items: [statusUpdate()], nextCursor: null },
    },
    filters: { type: null, status: null },
    onFiltersChange: vi.fn(),
    onNewIssue: vi.fn(),
    onRetryItems: vi.fn(),
    onRetryNotes: vi.fn(),
    onRetryStatusUpdates: vi.fn(),
    now,
    ...overrides,
  };
}

function renderProduct(overrides: Partial<ProductViewProps> = {}) {
  const p = props(overrides);
  render(<ProductView {...p} />);
  return p;
}

/** The view with the filters held in state, as the route holds them in the URL. */
function FilteredProduct(overrides: Partial<ProductViewProps>) {
  const [filters, setFilters] = useState<ItemFilters>({
    type: null,
    status: null,
  });
  return (
    <ProductView
      {...props(overrides)}
      filters={filters}
      onFiltersChange={setFilters}
    />
  );
}

const table = () => screen.getByRole("table");
const tableKeys = () =>
  [...table().querySelectorAll<HTMLElement>("[data-item-key]")].map(
    (row) => row.dataset.itemKey,
  );
const tableRow = (key: string) => {
  const row = table().querySelector(`[data-item-key="${key}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no ${key} row`);
  return row;
};
const tabs = () => screen.getByRole("tablist", { name: "Filter by status" });
const typeToggle = () => screen.getByRole("group", { name: "Filter by type" });
const titledUpdate = statusUpdate({
  author: { ...beta, title: "Release manager for the web client" },
});
const aside = (name: string) => screen.getByRole("region", { name });
const panes = () => screen.getByRole("tablist", { name: "Show" });
const paneTab = (name: string) => within(panes()).getByRole("tab", { name });
const pane = (name: string) => screen.getByRole("tabpanel", { name });

describe("items", () => {
  test("the columns read status, type, Key, Title, Priority, Labels, Assignee, Updated, the status and type headers for screen readers alone", () => {
    renderProduct();
    expect(
      within(table())
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Status",
      "Type",
      "Key",
      "Title",
      "Priority",
      "Labels",
      "Assignee",
      "Updated",
    ]);
    for (const name of ["Status", "Type"]) {
      expect(within(table()).getByText(name)).toHaveClass("sr-only");
    }
  });

  test("every row, in the table and below 1024px, carries a type glyph that follows its type", () => {
    renderProduct();
    const rendered = document.querySelectorAll<HTMLElement>("[data-item-key]");
    expect(rendered).toHaveLength(rows.length * 2);
    for (const row of rendered) {
      const item = rows.find((r) => r.key === row.dataset.itemKey);
      const glyph = row.querySelector<HTMLElement>("[data-item-type]");
      expect(glyph?.dataset.itemType).toBe(item?.type);
      // named in the table; below 1024px the row's description says the type
      const word = item?.type === "todo" ? "Todo" : "Issue";
      if (row.tagName === "TR") expect(glyph).toHaveAccessibleName(word);
      else expect(row).toHaveTextContent(word);
    }
  });

  test("an unassigned issue reads Unassigned; a todo never does", () => {
    renderProduct({
      items: {
        status: "ready",
        data: itemList([
          issueRow({ key: "TRL-19", assignee: null }),
          todoRow({ assignee: null }),
        ]),
      },
    });
    expect(tableRow("TRL-19")).toHaveTextContent("Unassigned");
    expect(tableRow("TRL-22")).not.toHaveTextContent("Unassigned");
    const phoneRow = (key: string) =>
      document.querySelector<HTMLElement>(`li[data-item-key="${key}"]`);
    expect(phoneRow("TRL-19")).toHaveTextContent("Unassigned");
    expect(phoneRow("TRL-22")).not.toHaveTextContent("Unassigned");
    expect(screen.getAllByText("Unassigned")).toHaveLength(2);
  });

  test("each row opens its item", () => {
    renderProduct();
    for (const link of screen.getAllByRole("link", {
      name: "TRL-17 Human UI: feed, projects, issue page",
    })) {
      expect(link).toHaveAttribute("href", "/products/TRL/17");
    }
  });

  test("below 1024px the whole row is the link, described by its type, status, assignee, priority and labels", () => {
    renderProduct();
    const item = document.querySelector('li[data-item-key="TRL-17"]');
    if (!(item instanceof HTMLElement)) throw new Error("no 375 row");
    const link = within(item).getByRole("link", {
      name: "TRL-17 Human UI: feed, projects, issue page",
    });
    expect(link).toHaveAccessibleDescription(
      /^Issue Open Assigned to Beta, bot .*ui design$/,
    );
  });

  test("a row's labels stay on one line in the table", () => {
    renderProduct();
    const labels = tableRow("TRL-17").querySelector(
      '[data-slot="badge"]',
    )?.parentElement;
    expect(labels).toHaveClass("overflow-hidden");
    expect(labels).not.toHaveClass("flex-wrap");
  });

  test("a canceled row's title is muted and None priority is a dash", () => {
    renderProduct();
    const [title] = screen.getAllByRole("link", { name: /^TRL-11 / });
    expect(title).toHaveClass("text-muted-foreground");
    const row = tableRow("TRL-11");
    expect(within(row).getByText("None")).toBeInTheDocument();
    expect(row.querySelector("svg.lucide-minus")).not.toBeNull();
  });

  test("no row offers a control for status, priority, labels or assignee", () => {
    renderProduct();
    for (const role of ["combobox", "listbox", "menu", "textbox", "checkbox"]) {
      expect(screen.queryAllByRole(role), role).toEqual([]);
    }
  });
});

describe("type toggle and status tabs", () => {
  test("while the next type's list loads, the toggle and tabs keep the counts the route holds; without them, they drop", () => {
    const { counts } = itemList(rows);
    const loading = (held?: ProductViewProps["counts"]) =>
      props({
        filters: { type: "issue", status: null },
        items: { status: "loading" },
        noteCounts: counts.notes,
        counts: held,
      });
    const { rerender } = render(<ProductView {...loading(counts)} />);
    expect(
      within(typeToggle()).getByRole("button", { name: "Issues 2" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(tabs()).getByRole("tab", { name: "All 2" })).toBeVisible();
    rerender(<ProductView {...loading()} />);
    expect(
      within(typeToggle()).getByRole("button", { name: "Issues" }),
    ).toBeInTheDocument();
    expect(within(tabs()).getByRole("tab", { name: "All" })).toBeVisible();
  });

  test("the toggle shows each type's count and All is pressed", () => {
    renderProduct();
    expect(
      within(typeToggle()).getByRole("button", { name: "All 4" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(typeToggle()).getByRole("button", { name: "Issues 2" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(typeToggle()).getByRole("button", { name: "Todos 2" }),
    ).toBeInTheDocument();
  });

  test("Todos shows no issue row, and the tab counts become the todos'", async () => {
    const user = userEvent.setup();
    render(<FilteredProduct />);
    expect(within(tabs()).getByRole("tab", { name: "All 4" })).toBeVisible();
    expect(
      within(tabs()).getByRole("tab", { name: "Canceled 1" }),
    ).toBeInTheDocument();
    await user.click(
      within(typeToggle()).getByRole("button", { name: /^Todos/ }),
    );
    expect(tableKeys()).toEqual(["TRL-22", "TRL-15"]);
    expect(
      [...document.querySelectorAll("[data-item-type]")].map(
        (b) => (b as HTMLElement).dataset.itemType,
      ),
    ).not.toContain("issue");
    for (const name of [
      "All 2",
      "Open 1",
      "In progress 1",
      "Done 0",
      "Canceled 0",
    ]) {
      expect(within(tabs()).getByRole("tab", { name })).toBeInTheDocument();
    }
  });

  test("Issues and a status tab combine", async () => {
    const user = userEvent.setup();
    render(<FilteredProduct />);
    await user.click(
      within(typeToggle()).getByRole("button", { name: /^Issues/ }),
    );
    await user.click(within(tabs()).getByRole("tab", { name: /^Canceled/ }));
    expect(tableKeys()).toEqual(["TRL-11"]);
  });

  test("selecting a tab reports the status with the type kept; All reports null", async () => {
    const user = userEvent.setup();
    const p = renderProduct({ filters: { type: "todo", status: "done" } });
    await user.click(within(tabs()).getByRole("tab", { name: /^In progress/ }));
    expect(p.onFiltersChange).toHaveBeenLastCalledWith({
      type: "todo",
      status: "in_progress",
    });
    await user.click(within(tabs()).getByRole("tab", { name: /^All/ }));
    expect(p.onFiltersChange).toHaveBeenLastCalledWith({
      type: "todo",
      status: null,
    });
  });

  test("the toggle works from the keyboard: arrows move, Space presses", async () => {
    const user = userEvent.setup();
    render(<FilteredProduct />);
    const all = within(typeToggle()).getByRole("button", { name: /^All/ });
    all.focus();
    await user.keyboard("{ArrowRight}");
    const issues = within(typeToggle()).getByRole("button", {
      name: /^Issues/,
    });
    expect(issues).toHaveFocus();
    await user.keyboard(" ");
    expect(issues).toHaveAttribute("aria-pressed", "true");
    expect(tableKeys()).toEqual(["TRL-17", "TRL-11"]);
  });

  test("the status tabs work from the keyboard", async () => {
    const user = userEvent.setup();
    render(<FilteredProduct />);
    within(tabs()).getByRole("tab", { name: /^All/ }).focus();
    await user.keyboard("{ArrowRight}{Enter}");
    expect(within(tabs()).getByRole("tab", { name: /^Open/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(tableKeys()).toEqual(["TRL-22", "TRL-17"]);
  });

  test("the 375 chips are All, Open, In progress and Done, and carry the same filter", async () => {
    const user = userEvent.setup();
    const p = renderProduct();
    const chips = screen.getByRole("group", { name: "Filter by status" });
    expect(
      within(chips)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["All", "Open", "In progress", "Done"]);
    await user.click(within(chips).getByRole("button", { name: "Done" }));
    expect(p.onFiltersChange).toHaveBeenLastCalledWith({
      type: null,
      status: "done",
    });
  });

  test("a filter with no rows says which and Show all clears both filters", async () => {
    const user = userEvent.setup();
    const p = renderProduct({ filters: { type: "todo", status: "done" } });
    expect(
      screen.getByRole("heading", { name: "No todos are done" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(p.onFiltersChange).toHaveBeenCalledWith({
      type: null,
      status: null,
    });
  });

  test("a status the chips don't list, Canceled from a shared link, gets a pressed chip of its own", () => {
    renderProduct({ filters: { type: null, status: "canceled" } });
    const chips = screen.getByRole("group", { name: "Filter by status" });
    expect(
      within(chips)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["All", "Open", "In progress", "Done", "Canceled"]);
    expect(
      within(chips).getByRole("button", { name: "Canceled" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  test("Show all leaves focus on the list, not the top of the page", async () => {
    const user = userEvent.setup();
    render(<FilteredProduct />);
    await user.click(within(tabs()).getByRole("tab", { name: /^Canceled/ }));
    await user.click(
      within(typeToggle()).getByRole("button", { name: /^Todos/ }),
    );
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("tabpanel", { name: /^All/ })).toHaveFocus();
  });

  test("Try again on the list leaves focus on the list", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ProductView {...props({ items: { status: "error" } })} />,
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    rerender(<ProductView {...props({ items: { status: "loading" } })} />);
    expect(screen.getByRole("tabpanel", { name: /^All/ })).toHaveFocus();
  });

  test("the status tab panel is focused from script only, never a Tab stop", () => {
    renderProduct();
    expect(screen.getByRole("tabpanel", { name: /^All/ })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  test("a product with no items at all offers New issue", async () => {
    const user = userEvent.setup();
    const p = renderProduct({ items: { status: "ready", data: itemList([]) } });
    expect(
      screen.getByRole("heading", { name: "No items in TRL yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Bots plan todos and file issues here. You can file an issue too.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New issue" }));
    expect(p.onNewIssue).toHaveBeenCalledOnce();
  });

  test("a product whose only items are notes says it has no issues or todos, still offers New issue, and lists the notes", async () => {
    const user = userEvent.setup();
    const p = renderProduct({
      items: {
        status: "ready",
        data: { items: [], nextCursor: null, counts: countsOf([noteRow()]) },
      },
      notes: { status: "ready", data: [noteRow()] },
    });
    expect(
      screen.getByRole("heading", { name: "No issues or todos in TRL yet" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "No items in TRL yet" }),
    ).toBeNull();
    expect(screen.getByRole("region", { name: /^Notes/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New issue" }));
    expect(p.onNewIssue).toHaveBeenCalledOnce();
  });

  test("a failed list says so and retries", async () => {
    const user = userEvent.setup();
    const p = renderProduct({ items: { status: "error" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load items");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.onRetryItems).toHaveBeenCalledOnce();
  });
});

describe("notes", () => {
  const current = [
    noteRow(),
    noteRow({ key: "TRL-33", title: "Release names follow the alphabet" }),
  ];
  const archived = noteRow({
    key: "TRL-29",
    title: "Old deploy steps",
    status: "archived",
  });
  // the server lists work without type; the counts carry the notes apart
  const workWithNotes = {
    ...itemList(rows),
    counts: countsOf([...rows, ...current, archived]),
  };
  const notesSection = () => screen.getByRole("region", { name: /^Notes/ });

  test("current notes show in a Notes section under the work list, each a link, and work counts leave them out", () => {
    renderProduct({
      items: { status: "ready", data: workWithNotes },
      notes: { status: "ready", data: current },
    });
    expect(
      within(notesSection()).getByRole("heading", { name: "Notes 2" }),
    ).toBeInTheDocument();
    expect(
      within(notesSection())
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual(["/products/TRL/31", "/products/TRL/33"]);
    expect(tableKeys()).not.toContain("TRL-31");
    expect(
      within(typeToggle()).getByRole("button", { name: "All 4" }),
    ).toBeInTheDocument();
    expect(
      within(typeToggle()).getByRole("button", { name: "Notes 3" }),
    ).toBeInTheDocument();
    expect(within(tabs()).getByRole("tab", { name: "All 4" })).toBeVisible();
  });

  test("Show archived notes lists the archived ones in the page's list, with focus on the list", async () => {
    const user = userEvent.setup();
    const p = renderProduct({
      items: { status: "ready", data: workWithNotes },
      notes: { status: "ready", data: current },
    });
    await user.click(
      within(notesSection()).getByRole("button", {
        name: "Show 1 archived note",
      }),
    );
    expect(p.onFiltersChange).toHaveBeenCalledWith({
      type: "note",
      status: "archived",
    });
    expect(screen.getByRole("tabpanel", { name: /^All/ })).toHaveFocus();
  });

  test("a list of notes has Current and Archived tabs, no Notes section, and no New issue for a product with no work", () => {
    renderProduct({
      filters: { type: "note", status: "archived" },
      items: {
        status: "ready",
        data: {
          items: [archived],
          nextCursor: null,
          counts: countsOf([...current, archived]),
        },
      },
    });
    expect(tableKeys()).toEqual(["TRL-29"]);
    expect(
      [...within(tabs()).getAllByRole("tab")].map((t) => t.textContent),
    ).toEqual(["All 3", "Current 2", "Archived 1"]);
    expect(screen.queryByRole("region", { name: /^Notes/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "New issue" })).toBeNull();
  });

  test("a list of notes has no Priority or Assignee column, and its rows no priority", () => {
    renderProduct({
      filters: { type: "note", status: "archived" },
      items: {
        status: "ready",
        data: {
          items: [{ ...archived, priority: 2 }],
          nextCursor: null,
          counts: countsOf([...current, archived]),
        },
      },
    });
    expect(
      within(table())
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Status", "Type", "Key", "Title", "Labels", "Updated"]);
    expect(tableRow("TRL-29").querySelectorAll("td")).toHaveLength(6);
    const phoneRow = screen.getByRole("link", {
      name: "TRL-29 Old deploy steps",
      description: /Note/,
    });
    expect(phoneRow).not.toHaveAccessibleDescription(
      new RegExp(priorityLabel(2)),
    );
  });

  test("a work row's phone description carries its priority, so the note row's lack is the rule", () => {
    renderProduct();
    const item = document.querySelector('li[data-item-key="TRL-17"]');
    if (!(item instanceof HTMLElement)) throw new Error("no 375 row");
    const link = within(item).getByRole("link", {
      name: "TRL-17 Human UI: feed, projects, issue page",
    });
    expect(link).toHaveAccessibleDescription(new RegExp(priorityLabel(2)));
  });

  test("a work list keeps its Priority and Assignee columns", () => {
    renderProduct();
    expect(
      within(table())
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "Status",
      "Type",
      "Key",
      "Title",
      "Priority",
      "Labels",
      "Assignee",
      "Updated",
    ]);
  });

  test("leaving Notes for a work type drops a note status", async () => {
    const user = userEvent.setup();
    const p = renderProduct({
      filters: { type: "note", status: "archived" },
      items: { status: "ready", data: workWithNotes },
    });
    await user.click(
      within(typeToggle()).getByRole("button", { name: /^Issues/ }),
    );
    expect(p.onFiltersChange).toHaveBeenCalledWith({
      type: "issue",
      status: null,
    });
  });

  test("leaving Notes for All: the notes list still answering Notes is not drawn as All, so its notes show once, in the Notes section", async () => {
    const user = userEvent.setup();
    const notesList = {
      items: [...current, archived],
      nextCursor: null,
      counts: workWithNotes.counts,
    };
    render(
      <FilteredProduct
        items={{ status: "ready", data: notesList }}
        notes={{ status: "ready", data: current }}
      />,
    );
    await user.click(
      within(typeToggle()).getByRole("button", { name: /^Notes/ }),
    );
    expect(tableKeys()).toEqual(["TRL-31", "TRL-33", "TRL-29"]);
    // the route lends this list to All until the work list lands, unless no row belongs there
    await user.click(
      within(typeToggle()).getByRole("button", { name: /^All/ }),
    );
    expect(
      notesList.items.some((note) => matchesFilters(note, NO_FILTERS)),
    ).toBe(false);
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getAllByRole("link", {
        name: "TRL-31 Why the feed reads newest first",
      }),
    ).toHaveLength(1);
    expect(notesSection()).toBeInTheDocument();
  });

  test("only archived notes: the section says there are no current ones and still links the archived", () => {
    renderProduct({
      items: {
        status: "ready",
        data: { ...itemList(rows), counts: countsOf([...rows, archived]) },
      },
    });
    expect(notesSection()).toHaveTextContent("No current notes.");
    expect(
      within(notesSection()).getByRole("button", {
        name: "Show 1 archived note",
      }),
    ).toBeInTheDocument();
  });

  test("a product with no notes has no Notes section", () => {
    renderProduct();
    expect(screen.queryByRole("region", { name: /^Notes/ })).toBeNull();
  });

  test("a failed notes list says so and retries", async () => {
    const user = userEvent.setup();
    const p = renderProduct({
      items: { status: "ready", data: workWithNotes },
      notes: { status: "error" },
    });
    expect(within(notesSection()).getByRole("alert")).toHaveTextContent(
      "Couldn't load notes",
    );
    await user.click(
      within(notesSection()).getByRole("button", { name: "Try again" }),
    );
    expect(p.onRetryNotes).toHaveBeenCalledOnce();
  });

  test("loading notes hold as many placeholder rows as the heading counts", () => {
    renderProduct({
      items: { status: "ready", data: workWithNotes },
      notes: { status: "loading" },
    });
    expect(
      within(notesSection()).getByRole("heading", { name: "Notes 2" }),
    ).toBeInTheDocument();
    const placeholder = within(notesSection()).getByRole("status");
    expect(placeholder.querySelectorAll(":scope > div")).toHaveLength(2);
  });

  test("Try again on notes leaves focus on their heading", async () => {
    const user = userEvent.setup();
    const items = { status: "ready", data: workWithNotes } as const;
    const { rerender } = render(
      <ProductView {...props({ items, notes: { status: "error" } })} />,
    );
    await user.click(
      within(notesSection()).getByRole("button", { name: "Try again" }),
    );
    rerender(
      <ProductView {...props({ items, notes: { status: "loading" } })} />,
    );
    expect(screen.getByRole("heading", { name: "Notes 2" })).toHaveFocus();
  });

  test("the Notes section stays while the list's counts reload, without Show archived notes until they're back", () => {
    renderProduct({
      filters: { type: "todo", status: null },
      items: { status: "loading" },
      notes: { status: "ready", data: current },
    });
    expect(
      within(notesSection()).getByRole("heading", { name: "Notes 2" }),
    ).toBeInTheDocument();
    expect(within(notesSection()).getAllByRole("link")).toHaveLength(2);
    expect(
      within(notesSection()).queryByRole("button", {
        name: /^Show [0-9]+ archived note/,
      }),
    ).toBeNull();
  });
});

describe("aside", () => {
  test("below lg the repo link under the heading is a 44px tap target", () => {
    renderProduct();
    const links = screen.getAllByRole("link", {
      name: /github\.com\/example\/trail/,
    });
    const phone = links.find((link) => link.classList.contains("lg:hidden"));
    expect(phone).toHaveClass("max-lg:min-h-11");
  });

  test("Repository shows the repo and opens GitHub; with no repo there is no section", () => {
    const { unmount } = render(<ProductView {...props()} />);
    const repo = within(aside("Repository")).getByRole("link");
    expect(repo).toHaveAttribute("href", "https://github.com/example/trail");
    expect(repo).toHaveTextContent("github.com/example/trail");
    unmount();
    renderProduct({ detail: productDetail({ repoUrl: null }) });
    expect(screen.queryByRole("region", { name: "Repository" })).toBeNull();
    expect(screen.queryByText(/github\.com/)).toBeNull();
  });

  test("Projects lists each project with health, lead and target; with none there is no section and no tab", () => {
    const { unmount } = render(<ProductView {...props()} />);
    const section = aside("Projects 2");
    const [human, team] = within(section).getAllByRole("listitem");
    if (!human || !team) throw new Error("missing project");
    expect(within(human).getByRole("link")).toHaveAttribute(
      "href",
      "/projects/human-ui",
    );
    expect(human).toHaveTextContent(
      /Human UI launch.*At risk.*Gamma.*Target Dec 4/,
    );
    expect(team).toHaveTextContent(
      /Team access.*On track.*Alpha.*Target Nov 30/,
    );
    unmount();
    renderProduct({ detail: productDetail({ projects: [], projectCount: 0 }) });
    expect(screen.queryByRole("region", { name: /^Projects/ })).toBeNull();
    expect(
      within(panes())
        .getAllByRole("tab")
        .map((b) => b.textContent),
    ).toEqual(["Items", "Status updates"]);
  });

  test("a project's health shows only with a status update, its target only with a date", () => {
    renderProduct({
      detail: productDetail({
        projects: [
          projectRow({
            latestStatusUpdate: null,
            health: "at_risk",
            targetDate: null,
          }),
        ],
        projectCount: 1,
      }),
    });
    const [project] = within(aside("Projects 1")).getAllByRole("listitem");
    expect(project).not.toHaveTextContent("At risk");
    expect(project).not.toHaveTextContent("Target");
  });

  test("status updates: author, badge, health and absolute time; none says so", () => {
    const { unmount } = render(<ProductView {...props()} />);
    const section = aside("Status updates");
    expect(within(section).getByText("Beta")).toBeInTheDocument();
    expect(within(section).getByText("On track")).toBeInTheDocument();
    expect(
      within(section).getByText(/^Nov 11, \d{2}:\d{2}$/),
    ).toBeInTheDocument();
    unmount();
    renderProduct({
      statusUpdates: { status: "ready", data: { items: [], nextCursor: null } },
    });
    expect(aside("Status updates")).toHaveTextContent("No status update yet");
  });

  test("a status update's bot name truncates only once its title has given way", () => {
    renderProduct({
      statusUpdates: {
        status: "ready",
        data: { items: [titledUpdate], nextCursor: null },
      },
    });
    const section = aside("Status updates");
    const name = within(section).getByText("Beta");
    expect(name).toHaveClass("shrink-0", "max-w-full", "truncate");
    expect(
      within(section).getByText("Release manager for the web client"),
    ).toHaveClass("min-w-0", "truncate", "shrink-4");
  });

  test("Try again on status updates leaves focus on their heading", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ProductView {...props({ statusUpdates: { status: "error" } })} />,
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    rerender(
      <ProductView {...props({ statusUpdates: { status: "loading" } })} />,
    );
    expect(
      screen.getByRole("heading", { name: "Status updates" }),
    ).toHaveFocus();
  });

  test("the 375 tabs show Items, Projects or Status updates, each a panel named by its tab", async () => {
    const user = userEvent.setup();
    renderProduct();
    expect(paneTab("Items")).toHaveAttribute("aria-selected", "true");
    await user.click(paneTab("Projects"));
    expect(paneTab("Projects")).toHaveAttribute("aria-selected", "true");
    expect(paneTab("Items")).toHaveAttribute("aria-selected", "false");
    const projects = pane("Projects");
    expect(paneTab("Projects")).toHaveAttribute("aria-controls", projects.id);
    expect(projects).toContainElement(aside("Projects 2"));
    expect(projects).not.toHaveAttribute("data-hidden");
    expect(pane("Items")).toHaveAttribute("data-hidden");
    expect(pane("Status updates")).toHaveAttribute("data-hidden");
    expect(pane("Status updates")).toContainElement(aside("Status updates"));
  });

  test("the footer sits at the end of the Items pane, so another pane hides it", async () => {
    const user = userEvent.setup();
    renderProduct({ footer: <p>Only the first 500 items are shown.</p> });
    const footer = screen.getByText("Only the first 500 items are shown.");
    expect(pane("Items")).toContainElement(footer);
    await user.click(paneTab("Status updates"));
    expect(pane("Items")).toHaveAttribute("data-hidden");
    expect(pane("Status updates")).not.toContainElement(footer);
  });

  test("every pane stays rendered and reachable for 1024px, where the breakpoint alone hides one", () => {
    renderProduct();
    for (const name of ["Items", "Projects", "Status updates"]) {
      const panel = pane(name);
      expect(panel).not.toHaveAttribute("hidden");
      expect(panel).not.toHaveAttribute("inert");
      expect(panel).toHaveClass("max-lg:data-hidden:hidden");
    }
  });

  test("the 375 tabs work from the keyboard", async () => {
    const user = userEvent.setup();
    renderProduct();
    paneTab("Items").focus();
    await user.keyboard("{ArrowRight}");
    expect(paneTab("Projects")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(paneTab("Projects")).toHaveAttribute("aria-selected", "true");
    expect(pane("Projects")).not.toHaveAttribute("data-hidden");
  });

  test("switching from the Projects pane to a product with no projects shows Items, selected", async () => {
    const user = userEvent.setup();
    const p = props();
    const { rerender } = render(<ProductView {...p} />);
    await user.click(paneTab("Projects"));
    const other = { key: "OPB", name: "OpenBot" };
    // the route reuses the view: the next product arrives as props, its detail still loading
    rerender(<ProductView {...p} product={other} detail={null} />);
    expect(paneTab("Items")).toHaveAttribute("aria-selected", "true");
    expect(pane("Items")).not.toHaveAttribute("data-hidden");
    rerender(
      <ProductView
        {...p}
        product={other}
        detail={productDetail({ projects: [], projectCount: 0 })}
      />,
    );
    expect(paneTab("Items")).toHaveAttribute("aria-selected", "true");
    expect(pane("Items")).not.toHaveAttribute("data-hidden");
    // its projects arriving later leave the person on Items
    rerender(<ProductView {...p} product={other} />);
    expect(paneTab("Items")).toHaveAttribute("aria-selected", "true");
  });

  test("while the detail loads, the list still shows and the aside has no repo or projects", () => {
    renderProduct({ detail: null });
    expect(tableKeys()).toHaveLength(rows.length);
    expect(screen.queryByRole("region", { name: "Repository" })).toBeNull();
    expect(screen.queryByRole("region", { name: /^Projects/ })).toBeNull();
  });
});

test("the Products link in the heading draws the shared focus outline", () => {
  render(<ProductHeading product={{ key: "TRL", name: "trail" }} />);
  expect(screen.getByRole("link", { name: "Products" })).toHaveClass(
    "focus-visible:outline-2",
    "focus-visible:outline-offset-2",
    "focus-visible:outline-ring",
  );
});
