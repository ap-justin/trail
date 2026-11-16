import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import type { ItemFilters } from "@/components/item-list";
import { ProductView, type ProductViewProps } from "@/components/product";
import {
  issueRow,
  itemList,
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
  return {
    product: trail,
    detail: productDetail(),
    items: { status: "ready", data: itemList(rows) },
    statusUpdates: {
      status: "ready",
      data: { items: [statusUpdate()], nextCursor: null },
    },
    filters: { type: null, status: null },
    onFiltersChange: vi.fn(),
    onNewIssue: vi.fn(),
    onRetryItems: vi.fn(),
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
const aside = (name: string) => screen.getByRole("region", { name });
const panes = () => screen.getByRole("tablist", { name: "Show" });
const paneTab = (name: string) => within(panes()).getByRole("tab", { name });
const pane = (name: string) => screen.getByRole("tabpanel", { name });

describe("items", () => {
  test("the columns read status, Key, Type, Title, Priority, Labels, Assignee, Updated", () => {
    renderProduct();
    expect(
      within(table())
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Status",
      "Key",
      "Type",
      "Title",
      "Priority",
      "Labels",
      "Assignee",
      "Updated",
    ]);
  });

  test("every row, in the table and below 1024px, carries a type badge that follows its type", () => {
    renderProduct();
    const rendered = document.querySelectorAll<HTMLElement>("[data-item-key]");
    expect(rendered).toHaveLength(rows.length * 2);
    for (const row of rendered) {
      const item = rows.find((r) => r.key === row.dataset.itemKey);
      const badge = row.querySelector<HTMLElement>("[data-item-type]");
      expect(badge?.dataset.itemType).toBe(item?.type);
      expect(badge).toHaveTextContent(item?.type === "todo" ? "Todo" : "Issue");
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
    expect(screen.getAllByText("Unassigned")).toHaveLength(1);
  });

  test("each row opens its item", () => {
    renderProduct();
    for (const link of screen.getAllByRole("link", {
      name: "TRL-17 Human UI: feed, projects, issue page",
    })) {
      expect(link).toHaveAttribute("href", "/products/TRL/17");
    }
  });

  test("below 1024px the whole row is the link, described by its type, status, priority, labels and assignee", () => {
    renderProduct();
    const item = document.querySelector('li[data-item-key="TRL-17"]');
    if (!(item instanceof HTMLElement)) throw new Error("no 375 row");
    const link = within(item).getByRole("link", {
      name: "TRL-17 Human UI: feed, projects, issue page",
    });
    expect(link).toHaveAccessibleDescription(
      /^Issue Open .*ui design Assigned to Tara, Bot$/,
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

  test("a product with no items at all offers New issue", async () => {
    const user = userEvent.setup();
    const p = renderProduct({ items: { status: "ready", data: itemList([]) } });
    expect(
      screen.getByRole("heading", { name: "No items in TRL yet" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New issue" }));
    expect(p.onNewIssue).toHaveBeenCalledOnce();
  });

  test("a failed list says so and retries", async () => {
    const user = userEvent.setup();
    const p = renderProduct({ items: { status: "error" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load issues");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.onRetryItems).toHaveBeenCalledOnce();
  });
});

describe("aside", () => {
  test("Repository shows the repo and opens GitHub; with no repo there is no section", () => {
    const { unmount } = render(<ProductView {...props()} />);
    const repo = within(aside("Repository")).getByRole("link");
    expect(repo).toHaveAttribute("href", "https://github.com/ap-justin/trail");
    expect(repo).toHaveTextContent("github.com/ap-justin/trail");
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
      /Human UI launch.*At risk.*Ada.*Target Dec 4/,
    );
    expect(team).toHaveTextContent(/Team access.*On track.*Kai.*Target Nov 30/);
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
    expect(within(section).getByText("Tara")).toBeInTheDocument();
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
