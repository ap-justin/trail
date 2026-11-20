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
  countsOf,
  docsSite,
  issueRow,
  noteRow,
  notesRead,
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
  const items: ProjectViewProps["items"] = overrides.items ?? {
    status: "ready",
    data: projectItems(groups),
  };
  return {
    // the route's: its own query, held while the list reloads
    noteCounts: (items.status === "ready" ? items.data : projectItems(groups))
      .counts.notes,
    project: {
      status: "ready",
      data: projectDetail({ products: [docsSite, trail] }),
    },
    items,
    counts: null,
    notes: { status: "ready", data: notesRead([]) },
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
    onRetryNotes: vi.fn(),
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
const typeToggle = () => screen.getByRole("group", { name: "Filter by type" });
const statusTabs = () =>
  within(screen.getByRole("tablist", { name: "Filter by status" }))
    .getAllByRole("tab")
    .map((t) => t.textContent);
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
      expect(header).toHaveTextContent(
        `${name} ${key} ${count} issues and todos`,
      );
      expect(rowsIn(body)).toBe(count);
    }
  });

  test("below 1024px each group is a section headed the same way", () => {
    renderProject();
    const section = screen.getByRole("region", {
      name: "trail TRL 3 issues and todos",
    });
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
      "Docs site DOC 2 issues and todos",
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

  test("the sheet holds Product and Type, applied as chosen, and the button counts them in the type's own word", async () => {
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
      within(sheet).getByRole("button", { name: "Show 2 todos" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      [...table().querySelectorAll<HTMLElement>("[data-item-type]")].map(
        (t) => t.dataset.itemType,
      ),
    ).toEqual(["todo", "todo"]);
    expect(filtersButton()).toHaveAccessibleName("Filters 1 in use");
  });

  test("the sheet's all-types option says All, as the lg toggle does: it lists issues and todos, not notes", async () => {
    const user = userEvent.setup();
    render(<FilteredProject />);
    await user.click(filtersButton());
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    await user.click(within(sheet).getByRole("combobox", { name: "Type" }));
    expect(
      (await screen.findAllByRole("option")).map((o) => o.textContent),
    ).toEqual(["All", "Issues", "Todos", "Notes"]);
  });

  test("under the Notes type the sheet's button counts notes, not items", async () => {
    const user = userEvent.setup();
    // 5 work items and 2 notes (1 current, 1 archived): All notes is 2, neither the work 5 nor the current 1
    render(
      <FilteredProject
        items={{
          status: "ready",
          data: {
            ...projectItems(groups),
            counts: countsOf([
              ...groups.flatMap((g) => g.items),
              noteRow(),
              noteRow({ key: "TRL-29", status: "archived" }),
            ]),
          },
        }}
      />,
    );
    await user.click(filtersButton());
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    await user.click(within(sheet).getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Notes" }));
    expect(
      await within(sheet).findByRole("button", { name: /^Show / }),
    ).toHaveAccessibleName("Show 2 notes");
  });

  test("under All the sheet's button counts issues and todos, not items", async () => {
    const user = userEvent.setup();
    render(<FilteredProject />);
    await user.click(filtersButton());
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    expect(
      within(sheet).getByRole("button", { name: /^Show / }),
    ).toHaveAccessibleName("Show 5 issues and todos");
  });

  test("the button counts the product and type in force; while the list loads the sheet has no count, only the type", async () => {
    const user = userEvent.setup();
    renderProject({
      filters: { type: "issue", status: null, product: "TRL" },
      items: { status: "loading" },
    });
    expect(filtersButton()).toHaveAccessibleName("Filters 2 in use");
    await user.click(filtersButton());
    expect(
      await screen.findByRole("button", { name: "Show issues" }),
    ).toBeInTheDocument();
  });

  test.each([
    [null, "Show issues and todos"],
    ["note", "Show notes"],
  ] as const)(
    "while the list loads under type %s the sheet's button reads %s, without a count",
    async (type, label) => {
      const user = userEvent.setup();
      renderProject({
        filters: { ...NO_PROJECT_FILTERS, type },
        items: { status: "loading" },
      });
      await user.click(filtersButton());
      const sheet = await screen.findByRole("dialog", { name: "Filters" });
      expect(
        within(sheet).getByRole("button", { name: /^Show / }),
      ).toHaveAccessibleName(label);
    },
  );
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

  test("while a tab's list loads, the tabs keep the counts the route holds; without them, they count only a ready list", () => {
    const { counts } = projectItems(groups);
    const { rerender } = render(
      <ProjectView
        {...props({
          filters: { ...NO_PROJECT_FILTERS, status: "done" },
          items: { status: "loading" },
          counts,
        })}
      />,
    );
    expect(statusTabs()).toEqual([
      "All 5",
      "Open 4",
      "In progress 1",
      "Done 0",
      "Canceled 0",
    ]);
    rerender(
      <ProjectView
        {...props({
          filters: { ...NO_PROJECT_FILTERS, status: "done" },
          items: { status: "loading" },
        })}
      />,
    );
    expect(statusTabs()).toEqual([
      "All ",
      "Open ",
      "In progress ",
      "Done ",
      "Canceled ",
    ]);
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

describe("notes", () => {
  const notes = [noteRow()];
  const archived = noteRow({
    key: "TRL-29",
    title: "Old deploy steps",
    status: "archived",
  });
  const withNotes = (work = groups) => ({
    ...projectItems(work),
    counts: countsOf([...work.flatMap((g) => g.items), ...notes, archived]),
  });

  test("current notes show in a Notes section under the work list; the tab and group counts leave them out", () => {
    renderProject({
      items: { status: "ready", data: withNotes() },
      notes: { status: "ready", data: notesRead(notes) },
    });
    const section = screen.getByRole("region", { name: /^Notes/ });
    expect(
      within(section).getByRole("link", {
        name: "TRL-31 Why the feed reads newest first",
      }),
    ).toHaveAttribute("href", "/products/TRL/31");
    // the notes are counted apart: the work list's tabs and its groups hold the 5 todos and issues only
    expect(
      within(screen.getByRole("tablist", { name: "Filter by status" }))
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["All 5", "Open 4", "In progress 1", "Done 0", "Canceled 0"]);
    const body = groupBody("TRL");
    expect(within(body).getByRole("columnheader")).toHaveTextContent(
      "trail TRL 3 issues and todos",
    );
    expect(rowsIn(body)).toBe(3);
    expect(
      within(table()).queryByText(/Why the feed reads newest first/),
    ).toBeNull();
  });

  test("Show archived notes keeps the product filter and lists the archived ones", async () => {
    const user = userEvent.setup();
    const p = renderProject({
      filters: { ...NO_PROJECT_FILTERS, product: "TRL" },
      items: { status: "ready", data: withNotes() },
      notes: { status: "ready", data: notesRead(notes) },
    });
    await user.click(
      screen.getByRole("button", { name: "Show 1 archived note" }),
    );
    expect(p.onFiltersChange).toHaveBeenCalledWith({
      product: "TRL",
      type: "note",
      status: "archived",
    });
  });

  test("every note archived and the notes list not loaded: the section says none are current and still offers the archived, whose list then shows", async () => {
    const user = userEvent.setup();
    const onlyArchived = {
      ...projectItems(groups),
      counts: countsOf([...groups.flatMap((g) => g.items), archived]),
    };
    const p = props({
      items: { status: "ready", data: onlyArchived },
      // the route's read of current notes never runs for a count of 0
      notes: { status: "loading" },
    });
    const { rerender } = render(<ProjectView {...p} />);
    const section = screen.getByRole("region", { name: /^Notes/ });
    expect(
      within(section).getByRole("heading", { name: "Notes 0" }),
    ).toBeInTheDocument();
    expect(within(section).getByText("No current notes.")).toBeInTheDocument();
    expect(within(section).queryByRole("status")).toBeNull();
    await user.click(
      within(section).getByRole("button", { name: "Show 1 archived note" }),
    );
    expect(p.onFiltersChange).toHaveBeenCalledWith({
      ...NO_PROJECT_FILTERS,
      type: "note",
      status: "archived",
    });
    rerender(
      <ProjectView
        {...p}
        filters={{ ...NO_PROJECT_FILTERS, type: "note", status: "archived" }}
        items={{
          status: "ready",
          data: {
            ...projectItems([{ product: trail, items: [archived] }]),
            counts: onlyArchived.counts,
          },
        }}
      />,
    );
    expect(
      screen.getAllByRole("link", { name: "TRL-29 Old deploy steps" }),
    ).not.toHaveLength(0);
  });

  test("a project with notes and no work lists its notes when asked, not the empty state, and its group counts notes", () => {
    renderProject({
      filters: { ...NO_PROJECT_FILTERS, type: "note", status: "archived" },
      items: {
        status: "ready",
        data: {
          ...projectItems([{ product: trail, items: [archived] }]),
          counts: countsOf([...notes, archived]),
        },
      },
    });
    expect(
      screen.queryByRole("heading", { name: "No items in this project yet" }),
    ).toBeNull();
    expect(
      screen.getAllByRole("link", { name: "TRL-29 Old deploy steps" }),
    ).not.toHaveLength(0);
    expect(screen.queryByRole("region", { name: /^Notes/ })).toBeNull();
    // a group of notes counts notes, at both widths
    expect(
      within(groupBody("TRL")).getByRole("columnheader"),
    ).toHaveTextContent("trail TRL 1 note");
    expect(
      screen.getByRole("region", { name: "trail TRL 1 note" }),
    ).toBeInTheDocument();
  });

  test("Show all on an empty notes filter keeps the notes and the product, and clears only the status", async () => {
    const user = userEvent.setup();
    const p = renderProject({
      filters: { product: "TRL", type: "note", status: "current" },
      items: {
        status: "ready",
        data: {
          ...projectItems([]),
          counts: countsOf([archived]),
        },
      },
    });
    expect(
      screen.getByRole("heading", { name: "No notes are current" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(p.onFiltersChange).toHaveBeenCalledWith({
      product: "TRL",
      type: "note",
      status: null,
    });
  });

  test("a project with notes and no work: Show archived notes leaves focus on the list", async () => {
    const user = userEvent.setup();
    const notesOnly = {
      ...projectItems([]),
      counts: countsOf([...notes, archived]),
    };
    const { rerender } = render(
      <ProjectView
        {...props({
          items: { status: "ready", data: notesOnly },
          notes: { status: "ready", data: notesRead(notes) },
        })}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Show 1 archived note" }),
    );
    rerender(
      <ProjectView
        {...props({
          filters: { ...NO_PROJECT_FILTERS, type: "note", status: "archived" },
          items: { status: "loading" },
          notes: { status: "ready", data: notesRead(notes) },
        })}
      />,
    );
    expect(screen.getByRole("tabpanel")).toHaveFocus();
  });

  test("a project with notes and no work keeps its filters: leaving the archived notes keeps focus on the pressed control, and the empty list doesn't say the project has no items", async () => {
    const user = userEvent.setup();
    render(
      <FilteredProject
        items={{
          status: "ready",
          data: {
            ...projectItems([{ product: trail, items: [archived] }]),
            counts: countsOf([...notes, archived]),
          },
        }}
        notes={{ status: "ready", data: notesRead(notes) }}
      />,
    );
    const noWork = () =>
      screen.getByRole("heading", {
        name: "No issues or todos in this project yet",
      });
    expect(noWork()).toBeInTheDocument();
    expect(screen.queryByText(/Bots add issues and todos/)).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Show 1 archived note" }),
    );
    expect(
      screen.getAllByRole("link", { name: "TRL-29 Old deploy steps" }),
    ).not.toHaveLength(0);
    const all = within(typeToggle()).getByRole("button", { name: /^All/ });
    await user.click(all);
    expect(all).toHaveFocus();
    expect(noWork()).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /^Notes/ })).toBeInTheDocument();
    const issues = within(typeToggle()).getByRole("button", {
      name: /^Issues/,
    });
    await user.click(issues);
    expect(issues).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("tabpanel", { name: /^All/ })).toHaveFocus();
    expect(noWork()).toBeInTheDocument();
  });

  test("the Notes section and Show archived notes stay while the work list reloads", () => {
    renderProject({
      filters: { ...NO_PROJECT_FILTERS, status: "open" },
      items: { status: "loading" },
      noteCounts: withNotes().counts.notes,
      notes: { status: "ready", data: notesRead(notes) },
    });
    const section = screen.getByRole("region", { name: /^Notes/ });
    expect(
      within(section).getByRole("heading", { name: "Notes 1" }),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("link", {
        name: "TRL-31 Why the feed reads newest first",
      }),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Show 1 archived note" }),
    ).toBeInTheDocument();
  });

  test("a notes read the page cap cut short says how many of its count show, newest first under a product filter, with no way to more", () => {
    renderProject({
      filters: { ...NO_PROJECT_FILTERS, product: "TRL" },
      items: { status: "ready", data: withNotes() },
      noteCounts: { current: 2134, archived: 1 },
      notes: {
        status: "ready",
        data: { items: notes, nextCursor: "after-31", total: 2134 },
      },
    });
    const section = screen.getByRole("region", { name: /^Notes/ });
    expect(
      within(section).getByText("Showing the newest 1 of 2,134 notes"),
    ).toBeInTheDocument();
    expect(within(section).getAllByRole("button")).toHaveLength(1);
  });

  test("across products the capped read runs A to Z by product, so its line says first, not newest", () => {
    renderProject({
      items: { status: "ready", data: withNotes() },
      noteCounts: { current: 2134, archived: 1 },
      notes: {
        status: "ready",
        data: { items: notes, nextCursor: "after-31", total: 2134 },
      },
    });
    expect(
      within(screen.getByRole("region", { name: /^Notes/ })).getByText(
        "Showing the first 1 of 2,134 notes",
      ),
    ).toBeInTheDocument();
  });

  test("Show archived notes keeps the product filter", async () => {
    const user = userEvent.setup();
    const p = renderProject({
      filters: { ...NO_PROJECT_FILTERS, product: "TRL" },
      items: { status: "ready", data: withNotes() },
      notes: { status: "ready", data: notesRead(notes) },
    });
    await user.click(
      within(screen.getByRole("region", { name: /^Notes/ })).getByRole(
        "button",
        { name: "Show 1 archived note" },
      ),
    );
    expect(p.onFiltersChange).toHaveBeenCalledWith({
      product: "TRL",
      type: "note",
      status: "archived",
    });
  });

  test("every current note shown: no Showing line and no button but the archived one", () => {
    renderProject({
      items: { status: "ready", data: withNotes() },
      notes: { status: "ready", data: notesRead(notes) },
    });
    const section = screen.getByRole("region", { name: /^Notes/ });
    expect(within(section).queryByText(/^Showing/)).toBeNull();
    expect(within(section).getAllByRole("button")).toHaveLength(1);
  });

  test("counts from a later list above the rows of an older read: no Showing line", () => {
    // a failed refetch keeps the older read's rows while another list's counts moved on
    renderProject({
      items: { status: "ready", data: withNotes() },
      noteCounts: { current: 4, archived: 1 },
      notes: { status: "ready", data: notesRead(notes) },
    });
    const section = screen.getByRole("region", { name: /^Notes/ });
    expect(
      within(section).getByRole("heading", { name: "Notes 4" }),
    ).toBeInTheDocument();
    expect(within(section).queryByText(/^Showing/)).toBeNull();
  });

  test("Try again on notes leaves focus on their heading", async () => {
    const user = userEvent.setup();
    const items = { status: "ready", data: withNotes() } as const;
    const { rerender } = render(
      <ProjectView {...props({ items, notes: { status: "error" } })} />,
    );
    const section = screen.getByRole("region", { name: /^Notes/ });
    await user.click(
      within(section).getByRole("button", { name: "Try again" }),
    );
    rerender(
      <ProjectView {...props({ items, notes: { status: "loading" } })} />,
    );
    expect(screen.getByRole("heading", { name: "Notes 1" })).toHaveFocus();
  });

  test("a project with no notes has no Notes section", () => {
    renderProject();
    expect(screen.queryByRole("region", { name: /^Notes/ })).toBeNull();
  });
});
