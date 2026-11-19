import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  NO_PROJECT_FILTERS,
  ProjectHeading,
  type ProjectItemFilters,
  ProjectView,
  type ProjectViewProps,
} from "@/components/project";
import { applyCompiledCss } from "@/test/compiled-css";
import {
  beta,
  docsSite,
  issueRow,
  projectDetail,
  projectItems,
  statusUpdate,
  todoRow,
  trail,
} from "@/test/fixtures";

const now = new Date("2026-11-11T12:00:00.000Z");

const docRows = [
  todoRow({ key: "DOC-8", title: "Draft the style guide intro" }),
  issueRow({
    key: "DOC-6",
    title: "Docs nav is missing the API page",
    assignee: null,
  }),
];
const trlRows = [
  todoRow(),
  issueRow(),
  issueRow({ key: "TRL-14", title: "Team access", status: "in_progress" }),
];
// the server's order: A to Z by product key
const groups = [
  { product: docsSite, items: docRows },
  { product: trail, items: trlRows },
];

function props(overrides: Partial<ProjectViewProps> = {}): ProjectViewProps {
  return {
    project: {
      status: "ready",
      data: projectDetail({ products: [docsSite, trail] }),
    },
    items: { status: "ready", data: projectItems(groups) },
    statusUpdates: {
      status: "ready",
      data: {
        items: [statusUpdate({ health: "at_risk" })],
        nextCursor: null,
      },
    },
    filters: NO_PROJECT_FILTERS,
    onFiltersChange: vi.fn(),
    onRetryProject: vi.fn(),
    onRetryItems: vi.fn(),
    onRetryStatusUpdates: vi.fn(),
    now,
    ...overrides,
  };
}

function renderProject(overrides: Partial<ProjectViewProps> = {}) {
  const p = props(overrides);
  render(<ProjectView {...p} />);
  return p;
}

function FilteredProject(overrides: Partial<ProjectViewProps>) {
  const [filters, setFilters] =
    useState<ProjectItemFilters>(NO_PROJECT_FILTERS);
  return (
    <ProjectView
      {...props(overrides)}
      filters={filters}
      onFiltersChange={setFilters}
    />
  );
}

const table = () => screen.getByRole("table");
const groupKeys = () =>
  [...table().querySelectorAll<HTMLElement>("tbody[data-group]")].map(
    (g) => g.dataset.group,
  );
const groupBody = (key: string) => {
  const body = table().querySelector(`tbody[data-group="${key}"]`);
  if (!(body instanceof HTMLElement)) throw new Error(`no ${key} group`);
  return body;
};
const rowsIn = (scope: HTMLElement) =>
  scope.querySelectorAll("tr[data-item-key]").length;
const details = () => screen.getByRole("region", { name: "Details" });
const HIDDEN = "Items from products you can't see are not shown.";

describe("goal and details", () => {
  test("the goal, then Details: lead with avatar and title, target, health, the visible products", () => {
    renderProject();
    expect(screen.getByText("Goal")).toBeInTheDocument();
    expect(
      screen.getByText(
        "People read the team's work in trail without asking a bot",
      ),
    ).toBeInTheDocument();
    const dl = within(details());
    const terms = dl.getAllByRole("term").map((dt) => dt.textContent);
    expect(terms).toEqual(["Lead", "Target", "Health", "Products"]);
    const [lead, target, health, products] = dl.getAllByRole("definition");
    expect(lead).toHaveTextContent(/Gamma.*Release engineer/);
    expect(
      within(lead as HTMLElement).getByRole("img", { name: "Gamma, bot" }),
    ).toBeVisible();
    expect(lead).not.toHaveTextContent("Bot");
    expect(target).toHaveTextContent(/^Dec 4$/);
    expect(health).toHaveTextContent(/^At risk$/);
    expect(products).toHaveTextContent(/Docs site DOC\s*trail TRL/);
  });

  test("no target drops the Target row; no status update drops Health", () => {
    renderProject({
      project: {
        status: "ready",
        data: projectDetail({
          targetDate: null,
          latestStatusUpdate: null,
          health: "at_risk",
        }),
      },
    });
    expect(
      within(details())
        .getAllByRole("term")
        .map((dt) => dt.textContent),
    ).toEqual(["Lead", "Products"]);
    expect(within(details()).queryByText("At risk")).toBeNull();
  });

  test("the 375 ledger has Lead and Target alone; the groups name the products", () => {
    renderProject();
    const inline = [...document.querySelectorAll("dl")].find(
      (dl) => !details().contains(dl),
    );
    if (!inline) throw new Error("no 375 ledger");
    expect(
      within(inline)
        .getAllByRole("term")
        .map((dt) => dt.textContent),
    ).toEqual(["Lead", "Target"]);
    expect(within(inline).queryByText("Products")).toBeNull();
    const phoneGroups = [
      ...document.querySelectorAll<HTMLElement>(
        ".lg\\:hidden section[data-group]",
      ),
    ];
    expect(
      phoneGroups.map((g) => [
        g.dataset.group,
        g.querySelector("h3")?.textContent,
      ]),
    ).toEqual([
      ["DOC", expect.stringMatching(/^Docs site\s*DOC/)],
      ["TRL", expect.stringMatching(/^trail\s*TRL/)],
    ]);
  });
});

describe("hidden products", () => {
  test("no line when the viewer sees every product", () => {
    renderProject();
    expect(screen.queryByText(HIDDEN)).toBeNull();
  });

  test("one line when some are hidden, and nothing of a hidden product anywhere", () => {
    renderProject({
      project: {
        status: "ready",
        data: projectDetail({
          products: [docsSite, trail],
          hiddenProducts: true,
        }),
      },
    });
    expect(screen.getAllByText(HIDDEN)).toHaveLength(1);
    const markup = document.body.innerHTML;
    for (const leak of ["OPB", "OpenBot"]) {
      expect(markup).not.toContain(leak);
    }
  });
});

describe("groups", () => {
  test("groups follow the given order, each headed by name, key and its count, which equals its rows under All", () => {
    renderProject();
    expect(groupKeys()).toEqual(["DOC", "TRL"]);
    for (const [key, name, count] of [
      ["DOC", "Docs site", 2],
      ["TRL", "trail", 3],
    ] as const) {
      const body = groupBody(key);
      const header = within(body).getByRole("columnheader");
      expect(header).toHaveTextContent(`${name} ${key} ${count} items`);
      expect(rowsIn(body)).toBe(count);
    }
  });

  test("below 1024px each group is a section headed the same way", () => {
    renderProject();
    const section = screen.getByRole("region", { name: "trail TRL 3 items" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
  });

  test("a group with no row under the filters is not drawn", async () => {
    const user = userEvent.setup();
    render(<FilteredProject />);
    await user.click(
      within(
        screen.getByRole("tablist", { name: "Filter by status" }),
      ).getByRole("tab", { name: /^In progress/ }),
    );
    expect(groupKeys()).toEqual(["TRL"]);
    expect(screen.queryByRole("region", { name: /^DOC/ })).toBeNull();
  });

  test("Todos shows no issue row in any group", async () => {
    const user = userEvent.setup();
    render(<FilteredProject />);
    await user.click(
      within(screen.getByRole("group", { name: "Filter by type" })).getByRole(
        "button",
        { name: /^Todos/ },
      ),
    );
    const types = [
      ...table().querySelectorAll<HTMLElement>("[data-item-type]"),
    ];
    expect(types.map((t) => t.dataset.itemType)).toEqual(["todo", "todo"]);
  });

  test("an unassigned issue reads Unassigned; rows have no Labels column", () => {
    renderProject();
    expect(
      within(table())
        .getAllByRole("columnheader")
        .slice(0, 8)
        .map((th) => th.textContent),
    ).toEqual([
      "Status",
      "Type",
      "Key",
      "Title",
      "Priority",
      "Assignee",
      "Updated",
      "Docs site DOC 2 items",
    ]);
    expect(table().querySelector('[data-item-key="DOC-6"]')).toHaveTextContent(
      "Unassigned",
    );
  });
});

describe("product select", () => {
  test("lists All products and only the products it is given, and reports the pick", async () => {
    const user = userEvent.setup();
    const p = renderProject();
    const select = screen.getByRole("combobox", { name: "Filter by product" });
    expect(select).toHaveTextContent("All products");
    await user.click(select);
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "All products",
      "Docs site DOC",
      "trail TRL",
    ]);
    await user.click(screen.getByRole("option", { name: "trail TRL" }));
    expect(p.onFiltersChange).toHaveBeenCalledWith({
      ...NO_PROJECT_FILTERS,
      product: "TRL",
    });
  });

  test("works from the keyboard", async () => {
    const user = userEvent.setup();
    render(<FilteredProject />);
    const select = screen.getByRole("combobox", { name: "Filter by product" });
    select.focus();
    await user.keyboard("{Enter}");
    await screen.findAllByRole("option");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(select).toHaveTextContent("trail");
    expect(groupKeys()).toEqual(["TRL"]);
  });
});

describe("375", () => {
  const filtersButton = () => screen.getByRole("button", { name: /^Filters/ });

  test("no pane tabs: the list, its footer, then Status updates, one page", () => {
    renderProject({ footer: <p>Only the first 500 items are shown.</p> });
    expect(screen.queryByRole("tablist", { name: "Show" })).toBeNull();
    const footer = screen.getByText("Only the first 500 items are shown.");
    const updates = screen.getByRole("region", { name: "Status updates" });
    expect(
      table().compareDocumentPosition(footer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      footer.compareDocumentPosition(updates) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(updates).getByRole("heading", { name: "Status updates" }),
    ).not.toHaveClass("max-lg:sr-only");
  });

  test("the status tabs are the phone's row too, every status with its count, and no chips", () => {
    renderProject();
    const tabs = screen.getByRole("tablist", { name: "Filter by status" });
    expect(tabs).not.toHaveClass("max-lg:hidden");
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["All 5", "Open 4", "In progress 1", "Done 0", "Canceled 0"]);
    expect(
      screen.queryByRole("group", { name: "Filter by status" }),
    ).toBeNull();
  });

  test("one Filters button below lg in place of the product select and type toggle", () => {
    renderProject();
    expect(filtersButton()).toHaveClass("lg:hidden");
    for (const control of [
      screen.getByRole("combobox", { name: "Filter by product" }),
      screen.getByRole("group", { name: "Filter by type" }),
    ]) {
      expect(control.closest(".max-lg\\:hidden")).not.toBeNull();
    }
  });

  test("the sheet holds Product and Type, applied as chosen, and says how many items show", async () => {
    const user = userEvent.setup();
    render(<FilteredProject />);
    await user.click(filtersButton());
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    expect(
      within(sheet).getByRole("combobox", { name: "Product" }),
    ).toBeInTheDocument();
    await user.click(within(sheet).getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Todos" }));
    await user.click(
      within(sheet).getByRole("button", { name: "Show 2 items" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      [...table().querySelectorAll<HTMLElement>("[data-item-type]")].map(
        (t) => t.dataset.itemType,
      ),
    ).toEqual(["todo", "todo"]);
    expect(filtersButton()).toHaveAccessibleName("Filters 1 in use");
  });

  test("the button counts the product and type in force; while the list loads the sheet has no count", async () => {
    const user = userEvent.setup();
    renderProject({
      filters: { type: "issue", status: null, product: "TRL" },
      items: { status: "loading" },
    });
    expect(filtersButton()).toHaveAccessibleName("Filters 2 in use");
    await user.click(filtersButton());
    expect(
      await screen.findByRole("button", { name: "Show items" }),
    ).toBeInTheDocument();
  });
});

describe("empty and failed", () => {
  test("a project with no items: the empty state and no tabs or filters", () => {
    renderProject({
      items: { status: "ready", data: projectItems([]) },
      statusUpdates: {
        status: "ready",
        data: { items: [], nextCursor: null },
      },
    });
    expect(
      screen.getByRole("heading", { name: "No items in this project yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Bots add issues and todos to a project. They show up here, grouped by product.",
      ),
    ).toBeInTheDocument();
    for (const name of ["Filter by status", "Filter by type"]) {
      expect(screen.queryByRole("tablist", { name })).toBeNull();
      expect(screen.queryByRole("group", { name })).toBeNull();
    }
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Show all|New issue/ }),
    ).toBeNull();
    expect(
      screen.getByRole("region", { name: "Status updates" }),
    ).toHaveTextContent("No status update yet");
  });

  test("a failed project load says so and retries", async () => {
    const user = userEvent.setup();
    const p = renderProject({ project: { status: "error" } });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load this project",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.onRetryProject).toHaveBeenCalledOnce();
  });

  test("a failed item list keeps the goal and details and retries the list", async () => {
    const user = userEvent.setup();
    const p = renderProject({ items: { status: "error" } });
    expect(details()).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(p.onRetryItems).toHaveBeenCalledOnce();
  });

  test("Try again and Show all leave focus on the list, not the top of the page", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ProjectView {...props({ items: { status: "error" } })} />,
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    rerender(<ProjectView {...props({ items: { status: "loading" } })} />);
    expect(screen.getByRole("tabpanel", { name: /^All/ })).toHaveFocus();
    const filtered = {
      product: null,
      type: "todo",
      status: "canceled",
    } as const;
    rerender(<ProjectView {...props({ filters: filtered })} />);
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("tabpanel", { name: /^Canceled/ })).toHaveFocus();
  });

  test("the status tab panel is focused from script only, never a Tab stop", () => {
    render(<ProjectView {...props()} />);
    expect(screen.getByRole("tabpanel", { name: /^All/ })).toHaveAttribute(
      "tabindex",
      "-1",
    );
  });

  // flex shrinks siblings in proportion, so a name that can shrink at all loses letters
  // while a long title is still on the line; only a name wider than the line may clip
  test("a status update's bot name truncates only once its title has given way", async () => {
    const title = "Release manager for the web and desktop clients";
    const { container } = render(
      <ProjectView
        {...props({
          statusUpdates: {
            status: "ready",
            data: {
              items: [
                statusUpdate({ author: { ...beta, name: "gamma", title } }),
              ],
              nextCursor: null,
            },
          },
        })}
      />,
    );
    onTestFinished(await applyCompiledCss(container));
    const section = screen.getByRole("region", { name: "Status updates" });
    const name = getComputedStyle(within(section).getByText("gamma"));
    expect(name.flexShrink).toBe("0");
    expect(name.maxWidth).toBe("100%");
    const titleNode = within(section).getByText(title);
    const titleStyle = getComputedStyle(titleNode);
    expect(titleStyle.flexShrink).not.toBe("0");
    expect(titleStyle.minWidth).toBe("0px");
    expect(titleStyle.overflow).toBe("hidden");
    expect(titleStyle.textOverflow).toBe("ellipsis");
    // the group holding both may shrink inside its grid track
    expect(getComputedStyle(titleNode.parentElement as Element).minWidth).toBe(
      "0px",
    );
  });

  test("Try again on status updates leaves focus on their heading", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ProjectView {...props({ statusUpdates: { status: "error" } })} />,
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    rerender(
      <ProjectView {...props({ statusUpdates: { status: "loading" } })} />,
    );
    expect(
      screen.getByRole("heading", { name: "Status updates" }),
    ).toHaveFocus();
  });
});

test("the Projects link in the heading is a 44px tap target below lg, its text's own box from lg", () => {
  render(<ProjectHeading project={{ name: "Docs site" }} />);
  const link = screen.getByRole("link", { name: "Projects" });
  expect(link).toHaveClass("max-lg:min-h-11", "max-lg:items-center");
  expect(link).not.toHaveClass("min-h-11");
});

test("the Projects link in the heading draws the shared focus outline", () => {
  render(<ProjectHeading project={{ name: "Docs site" }} />);
  expect(screen.getByRole("link", { name: "Projects" })).toHaveClass(
    "focus-visible:outline-2",
    "focus-visible:outline-offset-2",
    "focus-visible:outline-ring",
  );
});
