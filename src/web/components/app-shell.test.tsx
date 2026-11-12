import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { AccountPanel } from "@/components/account-panel";
import { AppShell, type ShellViewer } from "@/components/app-shell";
import { SearchResults } from "@/components/search-results";
import { ThemeProvider } from "@/components/theme-provider";

function renderShell(viewer: ShellViewer) {
  render(
    <ThemeProvider>
      <AppShell
        viewer={viewer}
        projects={[{ key: "TRL", name: "trail" }]}
        section="feed"
        heading="Feed"
        onSearch={vi.fn()}
        onNewIssue={vi.fn()}
        onSignOut={vi.fn()}
      >
        <p>page</p>
      </AppShell>
    </ThemeProvider>,
  );
}

// the sidebar (1440) and the tab bar (375) are both in the DOM; CSS shows one
const mainNavs = () => screen.getAllByRole("navigation", { name: "Main" });

describe("People nav", () => {
  test("the owner sees People in the sidebar and the tab bar", () => {
    renderShell({
      name: "Justin Salas",
      login: "justin",
      isOwner: true,
      photoUrl: null,
    });
    for (const nav of mainNavs()) {
      expect(within(nav).getByRole("link", { name: "People" })).toHaveAttribute(
        "href",
        "/people",
      );
    }
  });

  test("a member sees no People item anywhere", () => {
    renderShell({
      name: "Maya Chen",
      login: "mayachen",
      isOwner: false,
      photoUrl: null,
    });
    expect(mainNavs()).toHaveLength(2);
    expect(
      screen.queryByRole("link", { name: "People" }),
    ).not.toBeInTheDocument();
  });
});

test("the current section is marked for assistive tech", () => {
  renderShell({
    name: "Maya Chen",
    login: "mayachen",
    isOwner: false,
    photoUrl: null,
  });
  for (const nav of mainNavs()) {
    expect(within(nav).getByRole("link", { name: "Feed" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
});

test("the viewer's photo loads lazily in the sidebar's account menu (hidden below lg) and eagerly atop the account panel", () => {
  const viewer: ShellViewer = {
    name: "Maya Chen",
    login: "mayachen",
    isOwner: false,
    photoUrl: "/api/photos/a-maya/77b2",
  };
  renderShell(viewer);
  const trigger = screen.getByRole("button", { name: "Account: Maya Chen" });
  expect(trigger.querySelector("img")).toHaveAttribute("loading", "lazy");
  expect(trigger.querySelector("img")).toHaveAttribute(
    "src",
    "/api/photos/a-maya/77b2",
  );

  const { container } = render(
    <ThemeProvider>
      <AccountPanel viewer={viewer} onSignOut={vi.fn()} />
    </ThemeProvider>,
  );
  expect(container.querySelector("img")).toHaveAttribute("loading", "eager");
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    "/api/photos/a-maya/77b2",
  );
});

const owner: ShellViewer = {
  name: "Justin Salas",
  login: "justin",
  isOwner: true,
  photoUrl: null,
};

test("no heading draws no h1, so a page's own heading stands alone", () => {
  render(
    <ThemeProvider>
      <AppShell
        viewer={owner}
        projects={[]}
        section={null}
        heading={null}
        onSearch={vi.fn()}
        onNewIssue={vi.fn()}
        onSignOut={vi.fn()}
      >
        <h1>Page not found</h1>
      </AppShell>
    </ThemeProvider>,
  );
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
});

/** A caller that owns the text, as the routes do, and shows results while it's non-empty. */
function SearchingShell({ onSearch }: { onSearch: (q: string) => void }) {
  const [query, setQuery] = useState("");
  return (
    <ThemeProvider>
      <AppShell
        viewer={owner}
        projects={[]}
        section="feed"
        heading="Feed"
        searchValue={query}
        onSearch={(q) => {
          setQuery(q);
          onSearch(q);
        }}
        searchResults={
          query === "" ? null : (
            <SearchResults
              query={query}
              answeredQuery={query}
              status="ready"
              results={{
                projects: [],
                issues: [
                  {
                    key: "TRL-14",
                    sourceKey: null,
                    title: "Team access",
                    status: "open",
                    project: { key: "TRL", name: "trail" },
                  },
                ],
              }}
            />
          )
        }
        onNewIssue={vi.fn()}
        onSignOut={vi.fn()}
      >
        <p>page</p>
      </AppShell>
    </ThemeProvider>
  );
}

// the 1440 box; the 375 one mounts only once its toggle is pressed
const searchBox = () =>
  screen.getByRole("searchbox", { name: "Search issues" });

/** The scroll container around the results, and the slot that bounds its height. */
function resultsPanel(list: HTMLElement) {
  const panel = list.parentElement as HTMLElement;
  return { panel, slot: panel.parentElement as HTMLElement };
}

describe("search", () => {
  // jsdom lays nothing out, so the bound is read off the classes that draw it
  test("at 1440 the results scroll inside a panel bounded to the window under the top bar", async () => {
    render(<SearchingShell onSearch={vi.fn()} />);
    await userEvent.type(searchBox(), "team");
    const { panel, slot } = resultsPanel(
      screen.getByRole("list", { name: "Search results" }),
    );
    expect(slot).toHaveClass("absolute", "flex", "flex-col");
    expect(slot.className).toMatch(/\bmax-h-\[calc\(100dvh-/);
    expect(panel).toHaveClass("min-h-0", "overflow-y-auto");
  });

  test("at 375 the results scroll inside a panel bounded above the tab bar", async () => {
    const user = userEvent.setup();
    render(<SearchingShell onSearch={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Search" }));
    const phoneBox = screen.getAllByRole("searchbox", {
      name: "Search issues",
    })[1] as HTMLElement;
    await user.type(phoneBox, "team");
    // the 1440 box closed when focus moved to this one
    const { panel, slot } = resultsPanel(
      screen.getByRole("list", { name: "Search results" }),
    );
    expect(slot).not.toHaveClass("absolute");
    expect(slot).toHaveClass("flex", "flex-col");
    expect(slot.className).toMatch(/\bmax-h-\[calc\(100dvh-/);
    expect(panel).toHaveClass("min-h-0", "overflow-y-auto");
  });

  test("Escape from a result clears the box, closes the results and returns to the box", async () => {
    const onSearch = vi.fn();
    render(<SearchingShell onSearch={onSearch} />);
    await userEvent.type(searchBox(), "team");
    expect(
      screen.getByRole("list", { name: "Search results" }),
    ).toBeInTheDocument();

    await userEvent.tab();
    expect(screen.getByRole("link", { name: /TRL-14/ })).toHaveFocus();
    await userEvent.keyboard("{Escape}");

    expect(onSearch).toHaveBeenLastCalledWith("");
    expect(searchBox()).toHaveValue("");
    expect(searchBox()).toHaveFocus();
    expect(
      screen.queryByRole("list", { name: "Search results" }),
    ).not.toBeInTheDocument();
  });

  test("following a result ends the search", async () => {
    const onSearch = vi.fn();
    render(<SearchingShell onSearch={onSearch} />);
    await userEvent.type(searchBox(), "team");
    const link = screen.getByRole("link", { name: /TRL-14/ });
    link.addEventListener("click", (event) => event.preventDefault());
    await userEvent.click(link);
    expect(onSearch).toHaveBeenLastCalledWith("");
    expect(searchBox()).toHaveValue("");
  });

  test("focus leaving the search closes the results; focusing the box reopens them", async () => {
    const user = userEvent.setup();
    render(<SearchingShell onSearch={vi.fn()} />);
    await user.type(searchBox(), "team");
    // the 1440 New issue button; the 375 one is an icon button with the same name
    await user.click(
      screen.getAllByRole("button", { name: "New issue" })[0] as HTMLElement,
    );
    expect(
      screen.queryByRole("list", { name: "Search results" }),
    ).not.toBeInTheDocument();
    expect(searchBox()).toHaveValue("team");

    await user.click(searchBox());
    expect(
      screen.getByRole("list", { name: "Search results" }),
    ).toBeInTheDocument();
  });

  test("a click outside closes the results, a tab into them keeps them", async () => {
    const user = userEvent.setup();
    render(<SearchingShell onSearch={vi.fn()} />);
    await user.type(searchBox(), "team");
    await user.tab();
    expect(
      screen.getByRole("list", { name: "Search results" }),
    ).toBeInTheDocument();

    await user.click(screen.getByText("page"));
    expect(
      screen.queryByRole("list", { name: "Search results" }),
    ).not.toBeInTheDocument();
  });

  // Safari focuses no link on press: the box blurs with no relatedTarget before the click
  test("a pressed result survives the box blurring to nowhere, and the click follows it", async () => {
    const onSearch = vi.fn();
    render(<SearchingShell onSearch={onSearch} />);
    await userEvent.type(searchBox(), "team");
    const link = screen.getByRole("link", { name: /TRL-14/ });
    link.addEventListener("click", (event) => event.preventDefault());

    fireEvent.pointerDown(link);
    fireEvent.mouseDown(link);
    fireEvent.focusOut(searchBox(), { relatedTarget: null });
    fireEvent.pointerUp(link);
    fireEvent.mouseUp(link);

    expect(link).toBeInTheDocument();
    fireEvent.click(link);
    expect(onSearch).toHaveBeenLastCalledWith("");
  });

  test("a press outside the search closes the results", async () => {
    render(<SearchingShell onSearch={vi.fn()} />);
    await userEvent.type(searchBox(), "team");
    fireEvent.pointerDown(screen.getByText("page"));
    expect(
      screen.queryByRole("list", { name: "Search results" }),
    ).not.toBeInTheDocument();
    expect(searchBox()).toHaveValue("team");
  });

  test("tabbing past the results closes them", async () => {
    const user = userEvent.setup();
    render(<SearchingShell onSearch={vi.fn()} />);
    await user.type(searchBox(), "team");
    await user.tab();
    expect(screen.getByRole("link", { name: /TRL-14/ })).toHaveFocus();
    await user.tab();
    expect(
      screen.queryByRole("list", { name: "Search results" }),
    ).not.toBeInTheDocument();
  });

  test("the caller can clear the box from outside", () => {
    const shell = (value: string) => (
      <ThemeProvider>
        <AppShell
          viewer={owner}
          projects={[]}
          section="feed"
          heading="Feed"
          searchValue={value}
          onSearch={vi.fn()}
          onNewIssue={vi.fn()}
          onSignOut={vi.fn()}
        >
          <p>page</p>
        </AppShell>
      </ThemeProvider>
    );
    const { rerender } = render(shell("team"));
    expect(searchBox()).toHaveValue("team");
    rerender(shell(""));
    expect(searchBox()).toHaveValue("");
  });
});

function renderAt(props: {
  section: "projects" | null;
  projectKey?: string;
  back?: { href: string; label: string };
}) {
  render(
    <ThemeProvider>
      <AppShell
        viewer={owner}
        projects={[
          { key: "TRL", name: "trail" },
          { key: "OPB", name: "OpenBot" },
        ]}
        heading="TRL-14"
        onSearch={vi.fn()}
        onNewIssue={vi.fn()}
        onSignOut={vi.fn()}
        {...props}
      >
        <p>page</p>
      </AppShell>
    </ThemeProvider>,
  );
}

const sidebarNav = () => mainNavs()[0] as HTMLElement;
const tabNav = () => mainNavs()[1] as HTMLElement;
const projectsNav = () => screen.getByRole("navigation", { name: "Projects" });

describe("where the page sits", () => {
  test("a project page marks its own row, not Projects, in the sidebar", () => {
    renderAt({ section: "projects", projectKey: "TRL" });
    expect(
      within(sidebarNav()).getByRole("link", { name: "Projects" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(projectsNav()).getByRole("link", { name: "TRL trail" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(tabNav()).getByRole("link", { name: "Projects" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("an issue page marks its project's row and the Projects tab as its location", () => {
    renderAt({ section: null, projectKey: "TRL" });
    expect(
      within(projectsNav()).getByRole("link", { name: "TRL trail" }),
    ).toHaveAttribute("aria-current", "location");
    expect(
      within(projectsNav()).getByRole("link", { name: "OPB OpenBot" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(sidebarNav()).getByRole("link", { name: "Projects" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(tabNav()).getByRole("link", { name: "Projects" }),
    ).toHaveAttribute("aria-current", "location");
  });
});

test("back: a chevron link in the top bar, beside the heading", () => {
  renderAt({
    section: null,
    projectKey: "TRL",
    back: { href: "/projects/TRL", label: "Back to trail" },
  });
  expect(screen.getByRole("link", { name: "Back to trail" })).toHaveAttribute(
    "href",
    "/projects/TRL",
  );
  // one h1 per layout (top bar at 1440, top bar at 375), no separate heading row
  expect(
    screen.getAllByRole("heading", { level: 1, name: "TRL-14" }),
  ).toHaveLength(2);
  expect(document.querySelector("header + div h1")).toBeNull();
});

test("a breadcrumb heading is a nav, not an h1, so the page's own h1 stands alone", () => {
  render(
    <ThemeProvider>
      <AppShell
        viewer={owner}
        projects={[]}
        section={null}
        heading="TRL-14"
        headingKind="breadcrumb"
        back={{ href: "/projects/TRL", label: "Back to trail" }}
        onSearch={vi.fn()}
        onNewIssue={vi.fn()}
        onSignOut={vi.fn()}
      >
        <h1>Team access</h1>
      </AppShell>
    </ThemeProvider>,
  );
  expect(screen.getAllByRole("heading", { level: 1 })).toEqual([
    screen.getByRole("heading", { name: "Team access" }),
  ]);
  // top bar at 1440 and at 375; CSS shows one
  expect(
    screen.getAllByRole("navigation", { name: "Breadcrumb" }),
  ).toHaveLength(2);
});
