import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { FeedView, type FeedViewProps, LiveIndicator } from "@/components/feed";
import {
  alpha,
  alphaWithPhoto,
  beta,
  commentEntry,
  humanUi,
  itemCreatedEntry,
  maya,
  membershipEntry,
  productStatusUpdateEntry,
  projectEntry,
  projectImportedEntry,
  projectStatusUpdateEntry,
  statusEntry,
  teamAccess,
  typeChangedEntry,
} from "@/test/fixtures";

const now = new Date(2026, 10, 11, 12, 0);
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString();

function feedProps(overrides: Partial<FeedViewProps> = {}): FeedViewProps {
  return {
    status: "ready",
    entries: [
      commentEntry("e1", minutesAgo(1)),
      statusEntry("e2", minutesAgo(30)),
    ],
    freshIds: new Set(),
    connection: "open",
    pendingCount: 0,
    onShowPending: vi.fn(),
    onAtTopChange: vi.fn(),
    filters: {
      actors: [alpha],
      products: [{ key: "TRL", name: "trail" }],
      projects: [humanUi],
    },
    actorFilter: null,
    productFilter: null,
    projectFilter: null,
    typeFilter: null,
    onActorFilterChange: vi.fn(),
    onProductFilterChange: vi.fn(),
    onProjectFilterChange: vi.fn(),
    onTypeFilterChange: vi.fn(),
    onRetry: vi.fn(),
    now,
    ...overrides,
  };
}

function renderFeed(overrides: Partial<FeedViewProps> = {}) {
  const props = feedProps(overrides);
  render(<FeedView {...props} />);
  return props;
}

const rowFor = (id: string) => {
  const row = document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);
  if (!row) throw new Error(`no feed row ${id}`);
  return row;
};

const filterControls = () =>
  screen.queryAllByRole("combobox", {
    name: /^Filter by (bot|product|project|type)$/,
  });

describe("actor photos", () => {
  test("an entry by an actor with a photo shows the photo; one without shows initials", () => {
    renderFeed({
      entries: [
        commentEntry("e1", minutesAgo(1), { actor: alphaWithPhoto }),
        statusEntry("e2", minutesAgo(30)),
      ],
    });
    expect(rowFor("e1").querySelector("img")).toHaveAttribute(
      "src",
      alphaWithPhoto.photoUrl,
    );
    expect(rowFor("e2").querySelector("img")).toBeNull();
    expect(within(rowFor("e2")).getByText("A")).toBeInTheDocument();
  });
});

describe("feed highlight", () => {
  test("only rows whose ids are in freshIds carry the highlight", () => {
    renderFeed({ freshIds: new Set(["e1"]) });
    expect(rowFor("e1")).toHaveClass("row-fresh");
    expect(rowFor("e2")).not.toHaveClass("row-fresh");
  });

  test("a feed from the initial load has no highlighted row", () => {
    renderFeed();
    expect(document.querySelector(".row-fresh")).toBeNull();
  });
});

describe("N new pill", () => {
  test("is absent with nothing pending", () => {
    renderFeed({ pendingCount: 0 });
    expect(
      screen.queryByRole("button", { name: /new$/ }),
    ).not.toBeInTheDocument();
  });

  test("shows the count and calls back when pressed", async () => {
    const props = renderFeed({ pendingCount: 3 });
    await userEvent.click(screen.getByRole("button", { name: "3 new" }));
    expect(props.onShowPending).toHaveBeenCalledOnce();
  });

  // the shell's sticky top bar shares the pill's z-10; the feed's own stacking context keeps the
  // pill above the rows but under the bar and its search (paint order itself is a browser check)
  test("stacks inside the feed, so it never draws over the top bar", () => {
    const { container } = render(
      <FeedView {...feedProps({ pendingCount: 3 })} />,
    );
    const root = container.firstElementChild;
    expect(root).toHaveClass("isolate");
    expect(root).toContainElement(
      screen.getByRole("button", { name: "3 new" }),
    );
  });
});

describe("announcing new activity", () => {
  test("the live region is there before anything arrives, then names the pending count", () => {
    const props = feedProps();
    const { rerender } = render(<FeedView {...props} />);
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent(/^$/);
    rerender(<FeedView {...props} pendingCount={3} />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("3 new entries");
  });

  test("entries merged in at the top are announced", () => {
    const props = feedProps();
    const { rerender } = render(<FeedView {...props} />);
    rerender(
      <FeedView
        {...props}
        entries={[commentEntry("e0", minutesAgo(0)), ...props.entries]}
        freshIds={new Set(["e0"])}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 new entry");
  });
});

function PendingFeed() {
  const [pendingCount, setPendingCount] = useState(2);
  const [entries, setEntries] = useState([statusEntry("e2", minutesAgo(30))]);
  return (
    <FeedView
      {...feedProps()}
      entries={entries}
      pendingCount={pendingCount}
      onShowPending={() => {
        setPendingCount(0);
        setEntries((rows) => [commentEntry("e1", minutesAgo(1)), ...rows]);
      }}
    />
  );
}

describe("pressing N new", () => {
  test("moves focus to the first day heading, not the page top", async () => {
    const user = userEvent.setup();
    render(<PendingFeed />);
    await user.click(screen.getByRole("button", { name: "2 new" }));
    expect(screen.getAllByRole("heading", { level: 2 })[0]).toHaveFocus();
  });
});

describe("live connection", () => {
  test("open: Live shows and there is no banner", () => {
    renderFeed({ connection: "open" });
    render(<LiveIndicator connection="open" />);
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("reconnecting: the banner shows above the list and the rows stay", () => {
    renderFeed({ connection: "reconnecting" });
    render(<LiveIndicator connection="reconnecting" />);
    expect(screen.queryByText("Live")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Reconnecting… new activity will appear when it's back.",
    );
    expect(rowFor("e1")).toBeInTheDocument();
    expect(rowFor("e2")).toBeInTheDocument();
  });

  test("reconnecting with no projects and no entries: no banner, since nothing can arrive", () => {
    renderFeed({ entries: [], noProducts: true, connection: "reconnecting" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "No products yet" }),
    ).toBeInTheDocument();
  });

  test("reconnecting with noProducts but entries: the banner still shows", () => {
    renderFeed({ noProducts: true, connection: "reconnecting" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Reconnecting… new activity will appear when it's back.",
    );
    expect(rowFor("e1")).toBeInTheDocument();
  });
});

describe("feed states", () => {
  test("empty copy", () => {
    renderFeed({ entries: [] });
    expect(
      screen.getByRole("heading", { name: "No activity yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "When bots create issues, comment or post status updates, it shows up here as it happens.",
      ),
    ).toBeInTheDocument();
  });

  test("filters that match nothing say so and Clear filters drops each one in force", async () => {
    const user = userEvent.setup();
    const p = renderFeed({
      entries: [],
      productFilter: "TRL",
      projectFilter: humanUi.slug,
    });
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Nothing matches these filters" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(p.onProductFilterChange).toHaveBeenCalledWith(null);
    expect(p.onProjectFilterChange).toHaveBeenCalledWith(null);
    expect(p.onActorFilterChange).not.toHaveBeenCalled();
    expect(p.onTypeFilterChange).not.toHaveBeenCalled();
    // the button goes with the empty state; focus waits on the filters
    expect(
      screen.getByRole("group", { name: "Filter the feed" }),
    ).toHaveFocus();
  });

  test("a type filter alone that matches nothing offers Clear filters, which drops it", async () => {
    const user = userEvent.setup();
    const p = renderFeed({ entries: [], typeFilter: "todo" });
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(p.onTypeFilterChange).toHaveBeenCalledWith(null);
    expect(p.onProductFilterChange).not.toHaveBeenCalled();
  });

  test("a filter whose value has left the options reads All, not the raw value", () => {
    renderFeed({ actorFilter: "act_gone" });
    const bot = screen.getByRole("combobox", { name: "Filter by bot" });
    expect(bot).toHaveTextContent("All bots");
    expect(bot).not.toHaveTextContent("act_gone");
  });

  test("empty for a member with no project says so", () => {
    renderFeed({ entries: [], noProducts: true });
    expect(
      screen.getByRole("heading", { name: "No products yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Ask the person who runs this trail to give you access to a product.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("No activity yet")).not.toBeInTheDocument();
  });

  test("an empty feed for a member with no project shows no filters", () => {
    renderFeed({ entries: [], noProducts: true });
    expect(filterControls()).toHaveLength(0);
    expect(
      screen.getByRole("heading", { name: "No products yet" }),
    ).toBeInTheDocument();
  });

  test("noProducts is ignored once there are entries: rows and filters show", () => {
    renderFeed({ noProducts: true });
    expect(rowFor("e1")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "No products yet" }),
    ).not.toBeInTheDocument();
    expect(filterControls()).toHaveLength(4);
  });

  describe("an import row", () => {
    const importRow = (imported: { issues: number; comments: number }) => {
      renderFeed({
        entries: [projectImportedEntry("imp", minutesAgo(2), imported)],
      });
      return rowFor("imp");
    };
    // the muted connector is its own element, so the counts are the last span
    const tailOf = (row: HTMLElement) => within(row).queryByText(/^\d+ /);

    test("names the product as a link alongside imported and with", () => {
      const row = importRow({ issues: 12, comments: 1 });
      expect(
        within(row).getByRole("link", { name: "TRL trail" }),
      ).toBeVisible();
      expect(within(row).getByText("imported")).toBeInTheDocument();
      expect(within(row).getByText("with")).toBeInTheDocument();
    });

    test("unequal counts: each noun takes its own count and plural", () => {
      const tail = tailOf(importRow({ issues: 12, comments: 1 }));
      expect(tail?.textContent).toBe("12 issues, 1 comment");
    });

    test("one issue is singular", () => {
      const tail = tailOf(importRow({ issues: 1, comments: 3 }));
      expect(tail?.textContent).toBe("1 issue, 3 comments");
    });

    test("zero comments hides the comment count", () => {
      const tail = tailOf(importRow({ issues: 5, comments: 0 }));
      expect(tail?.textContent).toBe("5 issues");
    });

    test("zero issues hides the issue count", () => {
      const tail = tailOf(importRow({ issues: 0, comments: 4 }));
      expect(tail?.textContent).toBe("4 comments");
    });

    test("both zero shows no tail and no 'with'", () => {
      const row = importRow({ issues: 0, comments: 0 });
      expect(within(row).getByText("imported")).toBeInTheDocument();
      expect(within(row).queryByText("with")).not.toBeInTheDocument();
      expect(tailOf(row)).toBeNull();
      expect(row).not.toHaveTextContent(/\d+ (issue|comment)/);
    });
  });

  test("error copy, and Try again retries", async () => {
    const props = renderFeed({ status: "error" });
    const alert = screen.getByRole("alert");
    expect(
      within(alert).getByRole("heading", { name: "Couldn't load the feed" }),
    ).toBeInTheDocument();
    expect(
      within(alert).getByText("Check your connection, then try again."),
    ).toBeInTheDocument();
    await userEvent.click(
      within(alert).getByRole("button", { name: "Try again" }),
    );
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  test("loading renders no rows", () => {
    renderFeed({ status: "loading" });
    expect(
      screen.getAllByRole("status").some((s) => s.textContent === "Loading"),
    ).toBe(true);
    expect(document.querySelector("[data-entry-id]")).toBeNull();
  });
});

describe("feed rows", () => {
  test("a row opens its issue and names it", () => {
    renderFeed();
    expect(
      within(rowFor("e1")).getByRole("link", {
        name: "TRL-14 Team access: invite people",
      }),
    ).toHaveAttribute("href", "/products/TRL/14");
  });

  test("rows sit under day headers", () => {
    renderFeed({
      entries: [
        commentEntry("e1", minutesAgo(1)),
        statusEntry("e2", new Date(2026, 10, 10, 9, 0).toISOString()),
      ],
    });
    const headers = screen.getAllByRole("heading", { level: 2 });
    expect(headers.map((h) => h.textContent)).toEqual(["Today", "Yesterday"]);
  });

  test("an imported comment credits the bot and names the original author", () => {
    renderFeed({
      entries: [
        commentEntry("e1", minutesAgo(1), {
          comment: {
            id: "c1",
            body: "Ported from Linear.",
            sourceAuthor: "Jordan Smith",
          },
        }),
      ],
    });
    const row = rowFor("e1");
    expect(within(row).getByText("Alpha")).toBeInTheDocument();
    expect(
      within(row).getByText("originally by Jordan Smith"),
    ).toBeInTheDocument();
  });
});

test("a row of a kind this bundle doesn't know is skipped; the rest render", () => {
  // a kind the server added after this bundle shipped
  const unknown = {
    ...statusEntry("e2", minutesAgo(5)),
    kind: "project_archived",
  } as unknown as FeedViewProps["entries"][number];
  renderFeed({ entries: [commentEntry("e1", minutesAgo(1)), unknown] });
  expect(rowFor("e1")).toBeInTheDocument();
  expect(document.querySelector('[data-entry-id="e2"]')).toBeNull();
});

test("a comment's quote shows its words, not its Markdown", () => {
  renderFeed({
    entries: [
      commentEntry("e1", minutesAgo(1), {
        comment: {
          id: "c1",
          body: "Client **never sends** `Last-Event-ID`.",
          sourceAuthor: null,
        },
      }),
    ],
  });
  expect(rowFor("e1")).toHaveTextContent("Client never sends Last-Event-ID.");
  expect(rowFor("e1")).not.toHaveTextContent("**");
});

describe("item events", () => {
  test("carry one grey type glyph, named for the type, before the key", () => {
    renderFeed({
      entries: [
        commentEntry("e1", minutesAgo(1)),
        itemCreatedEntry("e2", minutesAgo(2), {
          item: { key: "TRL-15", title: "Back up the volume", type: "todo" },
        }),
      ],
    });
    const issueIcon = within(rowFor("e1")).getByRole("img", { name: "Issue" });
    expect(issueIcon).toHaveClass("lucide-inbox", "text-muted-foreground");
    const todoIcon = within(rowFor("e2")).getByRole("img", { name: "Todo" });
    expect(todoIcon).toHaveClass("lucide-list-todo");
    // a glyph alone: no boxed chip, no word
    expect(within(rowFor("e2")).queryByText("Todo")).toBeNull();
    // the glyph sits before the key link
    const key = within(rowFor("e2")).getByRole("link", {
      name: "TRL-15 Back up the volume",
    });
    expect(
      todoIcon.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("bots and people file issues; bots plan todos", () => {
    renderFeed({
      entries: [
        itemCreatedEntry("bot-issue", minutesAgo(1)),
        itemCreatedEntry("bot-todo", minutesAgo(2), {
          item: { key: "TRL-15", title: "Back up the volume", type: "todo" },
        }),
        itemCreatedEntry("person", minutesAgo(3), { actor: maya }),
      ],
    });
    expect(within(rowFor("bot-issue")).getByText("filed")).toBeVisible();
    expect(within(rowFor("bot-todo")).getByText("planned")).toBeVisible();
    expect(within(rowFor("person")).getByText("filed")).toBeVisible();
  });

  test("an issue a bot filed and the owner accepted as a todo still reads filed", () => {
    renderFeed({
      entries: [
        itemCreatedEntry("accepted", minutesAgo(1), {
          item: { key: "TRL-15", title: "Back up the volume", type: "todo" },
          createdAs: "issue",
        }),
      ],
    });
    const row = rowFor("accepted");
    expect(within(row).getByText("filed")).toBeVisible();
    expect(within(row).queryByText("planned")).toBeNull();
  });

  test("a change into triage reads to Triage, not Open", () => {
    renderFeed({
      entries: [
        statusEntry("e1", minutesAgo(1), { from: "open", to: "triage" }),
      ],
    });
    const row = rowFor("e1");
    expect(row).toHaveTextContent(/to\s*Triage/);
    expect(row).not.toHaveTextContent("Open");
  });

  test("accepting an issue out of triage reads to Open", () => {
    renderFeed({
      entries: [
        statusEntry("e1", minutesAgo(1), { from: "triage", to: "open" }),
      ],
    });
    expect(rowFor("e1")).toHaveTextContent(/to\s*Open/);
  });

  test("a type change names the new type", () => {
    renderFeed({ entries: [typeChangedEntry("e1", minutesAgo(1))] });
    const row = rowFor("e1");
    expect(row).toHaveTextContent(/changed type of\s*TRL-14/);
    expect(row).toHaveTextContent(/to\s*Todo/);
  });

  test("adding to and removing from a project name the project", () => {
    renderFeed({
      entries: [
        membershipEntry("add", minutesAgo(1), "added_to_project"),
        membershipEntry("remove", minutesAgo(2), "removed_from_project"),
      ],
    });
    expect(rowFor("add")).toHaveTextContent(
      /added\s*TRL-14.*to project\s*Human UI launch/,
    );
    expect(rowFor("remove")).toHaveTextContent(
      /removed\s*TRL-14.*from project\s*Human UI launch/,
    );
    // the item is the row's one link
    expect(within(rowFor("add")).getAllByRole("link")).toHaveLength(1);
  });
});

describe("status update rows", () => {
  test("a project update names the project and leaves the right column empty", () => {
    renderFeed({ entries: [projectStatusUpdateEntry("e1", minutesAgo(1))] });
    const row = rowFor("e1");
    expect(row).toHaveTextContent("posted a status update on project");
    expect(
      within(row).getByRole("link", { name: "Human UI launch" }),
    ).toHaveAttribute("href", "/projects/human-ui");
    expect(within(row).getByText("At risk")).toBeInTheDocument();
    expect(row.querySelector("[data-product-column]")).toBeEmptyDOMElement();
  });

  test("a product update names the product by key and name, and carries the key at the right", () => {
    renderFeed({ entries: [productStatusUpdateEntry("e1", minutesAgo(1))] });
    const row = rowFor("e1");
    expect(row).toHaveTextContent("posted a status update on product");
    expect(
      within(row).getByRole("link", { name: "OPB OpenBot" }),
    ).toHaveAttribute("href", "/products/OPB");
    expect(row.querySelector("[data-product-column]")).toHaveTextContent(
      /^OPB$/,
    );
  });

  test("an item event carries its product key at the right", () => {
    renderFeed();
    expect(
      rowFor("e1").querySelector("[data-product-column]"),
    ).toHaveTextContent(/^TRL$/);
  });

  test("a project created or edited names the project, with no product key", () => {
    renderFeed({
      entries: [
        projectEntry("made", minutesAgo(1), "project_created"),
        projectEntry("edit", minutesAgo(2), "project_updated"),
      ],
    });
    expect(rowFor("made")).toHaveTextContent(
      /created project\s*Human UI launch/,
    );
    expect(rowFor("edit")).toHaveTextContent(
      /updated project\s*Human UI launch/,
    );
    expect(
      rowFor("made").querySelector("[data-product-column]"),
    ).toBeEmptyDOMElement();
  });
});

describe("filters", () => {
  test("four filters: bots, products, projects and types, each starting at All", () => {
    renderFeed();
    const [bots, products, projects, types] = filterControls();
    expect(bots).toHaveTextContent("All bots");
    expect(products).toHaveTextContent("All products");
    expect(projects).toHaveTextContent("All projects");
    expect(types).toHaveTextContent("All types");
  });

  test("the type menu offers Issues and Todos and chooses by type", async () => {
    const user = userEvent.setup();
    const props = renderFeed();
    await user.click(screen.getByRole("combobox", { name: "Filter by type" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "All types",
      "Issues",
      "Todos",
    ]);
    await user.click(screen.getByRole("option", { name: "Todos" }));
    expect(props.onTypeFilterChange).toHaveBeenCalledWith(
      "todo",
      expect.anything(),
    );
  });

  test("the chosen type shows on the trigger", () => {
    renderFeed({ typeFilter: "issue" });
    expect(
      screen.getByRole("combobox", { name: "Filter by type" }),
    ).toHaveTextContent("Issues");
  });

  test("the product menu lists only the products given, key then name", async () => {
    const user = userEvent.setup();
    const props = renderFeed({
      filters: {
        actors: [alpha],
        products: [
          { key: "TRL", name: "trail" },
          { key: "OPB", name: "OpenBot" },
        ],
        projects: [humanUi],
      },
    });
    await user.click(
      screen.getByRole("combobox", { name: "Filter by product" }),
    );
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "All products",
      "TRL trail",
      "OPB OpenBot",
    ]);
    await user.click(screen.getByRole("option", { name: "OPB OpenBot" }));
    expect(props.onProductFilterChange).toHaveBeenCalledWith("OPB");
  });

  test("the project menu lists only the projects given and chooses by slug", async () => {
    const user = userEvent.setup();
    const props = renderFeed({
      filters: {
        actors: [alpha],
        products: [],
        projects: [humanUi, teamAccess],
      },
    });
    await user.click(
      screen.getByRole("combobox", { name: "Filter by project" }),
    );
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "All projects",
      "Human UI launch",
      "Team access",
    ]);
    await user.click(screen.getByRole("option", { name: "Team access" }));
    expect(props.onProjectFilterChange).toHaveBeenCalledWith(
      "team-access",
      expect.anything(),
    );
  });
});

describe("row marks", () => {
  test("no Bot or Human word in any row: the avatar shape is the one kind mark", () => {
    renderFeed({
      entries: [
        commentEntry("bot", minutesAgo(1)),
        itemCreatedEntry("person", minutesAgo(2), { actor: maya }),
      ],
    });
    for (const id of ["bot", "person"]) {
      expect(within(rowFor(id)).queryByText(/^(?:Bot|Human)$/)).toBeNull();
    }
  });

  test("every avatar and type glyph in a row has an accessible name", () => {
    renderFeed({
      entries: [
        commentEntry("bot", minutesAgo(1)),
        itemCreatedEntry("person", minutesAgo(2), { actor: maya }),
      ],
    });
    expect(
      within(rowFor("bot")).getByRole("img", { name: "Alpha, bot" }),
    ).toHaveAttribute("data-actor-kind", "bot");
    expect(
      within(rowFor("person")).getByRole("img", { name: "Maya Chen, person" }),
    ).toHaveAttribute("data-actor-kind", "human");
    for (const img of document.querySelectorAll(
      "[data-entry-id] [data-actor-kind], [data-entry-id] [data-item-type]",
    )) {
      expect(img).toHaveAttribute("role", "img");
      expect(img).toHaveAccessibleName();
    }
  });

  test("rows part by pitch alone, and a quote has no bar", () => {
    renderFeed();
    const row = rowFor("e1");
    expect(row.className).not.toMatch(/\bborder/);
    const quote = within(row).getByText("Owner-only invite is right.");
    expect(quote.closest("p")?.className).not.toMatch(/\bborder/);
  });
});

describe("Filters on the phone", () => {
  const filtersButton = () => screen.getByRole("button", { name: /^Filters/ });

  test("one Filters button below lg in place of the chips, which show from lg", () => {
    renderFeed();
    expect(filtersButton()).toHaveClass("lg:hidden");
    expect(filtersButton().querySelector("svg")).toHaveClass(
      "lucide-sliders-horizontal",
    );
    const chip = screen.getByRole("combobox", { name: "Filter by bot" });
    expect(chip.closest(".max-lg\\:hidden")).not.toBeNull();
    expect(filtersButton().closest(".max-lg\\:hidden")).toBeNull();
  });

  test("opens a sheet titled Filters with a labelled select per filter, applied as chosen", async () => {
    const user = userEvent.setup();
    const props = renderFeed();
    await user.click(filtersButton());
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    for (const label of ["Bot", "Product", "Project", "Type"]) {
      expect(
        within(sheet).getByRole("combobox", { name: label }),
      ).toBeInTheDocument();
    }
    await user.click(within(sheet).getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Todos" }));
    expect(props.onTypeFilterChange).toHaveBeenCalledWith(
      "todo",
      expect.anything(),
    );
  });

  test("the sheet's primary button says how many events show, and closes it", async () => {
    const user = userEvent.setup();
    renderFeed();
    await user.click(filtersButton());
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    await user.click(
      within(sheet).getByRole("button", { name: "Show 2 events" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  test("one event is singular; while the feed loads there is no count", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <FeedView
        {...feedProps({ entries: [commentEntry("e1", minutesAgo(1))] })}
      />,
    );
    await user.click(filtersButton());
    expect(
      await screen.findByRole("button", { name: "Show 1 event" }),
    ).toBeInTheDocument();
    rerender(<FeedView {...feedProps({ status: "loading" })} />);
    expect(
      screen.getByRole("button", { name: "Show events" }),
    ).toBeInTheDocument();
  });

  test("the button counts the filters in force", () => {
    renderFeed({ actorFilter: alpha.id, typeFilter: "issue" });
    expect(filtersButton()).toHaveAccessibleName("Filters 2 in use");
  });
});

describe("Working now", () => {
  test("shows above the filters when a bot has an item in progress", () => {
    renderFeed({
      workingNow: [
        { bot: beta, item: { key: "TRL-15", title: "Back up the volume" } },
      ],
    });
    const strip = screen.getByRole("region", { name: "Working now" });
    expect(
      within(strip).getByRole("link", {
        name: "Beta is working on TRL-15 Back up the volume",
      }),
    ).toHaveAttribute("href", "/products/TRL/15");
    expect(
      strip.compareDocumentPosition(filtersButtonOrGroup()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("is absent while no bot has an item in progress", () => {
    renderFeed({ workingNow: [] });
    expect(
      screen.queryByRole("region", { name: "Working now" }),
    ).not.toBeInTheDocument();
  });
});

const filtersButtonOrGroup = () =>
  screen.getByRole("group", { name: "Filter the feed" });
