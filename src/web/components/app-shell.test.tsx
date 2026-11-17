import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { sessionOf } from "@/app/chrome";
import { AccountPanel } from "@/components/account-panel";
import {
  AppShell,
  type ShellSection,
  type ShellViewer,
} from "@/components/app-shell";
import { IssueBreadcrumb } from "@/components/issue";
import { ProductHeading } from "@/components/product";
import { ProjectHeading } from "@/components/project";
import { SearchResults } from "@/components/search-results";
import { ThemeProvider } from "@/components/theme-provider";
import type { MeView } from "@/lib/api-types";
import { applyCompiledCss } from "@/test/compiled-css";
import { photoUrlFor } from "@/test/fixtures";

function renderShell(viewer: ShellViewer) {
  render(
    <ThemeProvider>
      <AppShell
        viewer={viewer}
        products={[{ key: "TRL", name: "trail" }]}
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
      name: "Jordan Smith",
      handle: "@jordan",
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
      handle: "@mayachen",
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
    handle: "@mayachen",
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

test("the viewer's photo shows in the sidebar's account menu (hidden below lg) and loads eagerly atop the account panel", () => {
  const viewer: ShellViewer = {
    name: "Maya Chen",
    handle: "@mayachen",
    isOwner: false,
    photoUrl: photoUrlFor("a-maya", "77"),
  };
  renderShell(viewer);
  const trigger = screen.getByRole("button", { name: "Account: Maya Chen" });
  // the sheet shows the sidebar only from lg up, so below it the img never renders; lazy keeps it from fetching
  const sidebar = trigger.closest("aside");
  expect(sidebar).toHaveClass("hidden", "lg:flex");
  expect(trigger.querySelector("img")).toHaveAttribute(
    "src",
    photoUrlFor("a-maya", "77"),
  );
  expect(trigger.querySelector("img")).toHaveAttribute("loading", "lazy");

  const { container } = render(
    <ThemeProvider>
      <AccountPanel viewer={viewer} onSignOut={vi.fn()} />
    </ThemeProvider>,
  );
  expect(container.querySelector("img")).toHaveAttribute("loading", "eager");
  expect(container.querySelector("img")).toHaveAttribute(
    "src",
    photoUrlFor("a-maya", "77"),
  );
});

test("the shell's viewer carries the photo URL `/me` gives the signed-in actor", () => {
  const me: MeView = {
    state: "member",
    login: "mayachen",
    email: null,
    actor: {
      id: "a-maya",
      name: "Maya Chen",
      kind: "human",
      photoUrl: photoUrlFor("a-maya", "77"),
      title: null,
    },
    products: [],
    ownerName: "Jordan Smith",
    emailSignIn: true,
  };
  expect(sessionOf(me)?.viewer).toEqual({
    name: "Maya Chen",
    handle: "@mayachen",
    isOwner: false,
    photoUrl: photoUrlFor("a-maya", "77"),
  });
});

test("a person who signs in by email is let into the shell, shown by their address", () => {
  const me: MeView = {
    state: "member",
    login: null,
    email: "dana@example.com",
    actor: {
      id: "a-dana",
      name: "dana.okafor",
      kind: "human",
      photoUrl: null,
      title: null,
    },
    products: [],
    ownerName: "Jordan Smith",
    emailSignIn: true,
  };
  expect(sessionOf(me)?.viewer).toEqual({
    name: "dana.okafor",
    handle: "dana@example.com",
    isOwner: false,
    photoUrl: null,
  });
});

const owner: ShellViewer = {
  name: "Jordan Smith",
  handle: "@jordan",
  isOwner: true,
  photoUrl: null,
};

test("no heading draws no h1, so a page's own heading stands alone", () => {
  render(
    <ThemeProvider>
      <AppShell
        viewer={owner}
        products={[]}
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
        products={[]}
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
                products: [],
                projects: [],
                items: [
                  {
                    key: "TRL-14",
                    sourceKey: null,
                    title: "Team access",
                    type: "issue",
                    status: "open",
                    product: { key: "TRL", name: "trail" },
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
          products={[]}
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
  section: ShellSection | null;
  productKey?: string;
  back?: { href: string; label: string };
}) {
  render(
    <ThemeProvider>
      <AppShell
        viewer={owner}
        products={[
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
const productsNav = () => screen.getByRole("navigation", { name: "Products" });
const names = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent);

describe("main nav", () => {
  test("the sidebar reads Feed, Products, Projects, People, Messages; the tab bar adds Account", () => {
    renderShell(owner);
    expect(names(sidebarNav())).toEqual([
      "Feed",
      "Products",
      "Projects",
      "People",
      "Messages",
    ]);
    expect(names(tabNav())).toEqual([
      "Feed",
      "Products",
      "Projects",
      "People",
      "Messages",
      "Account",
    ]);
    for (const nav of mainNavs()) {
      expect(
        within(nav).getByRole("link", { name: "Products" }),
      ).toHaveAttribute("href", "/products");
      expect(
        within(nav).getByRole("link", { name: "Projects" }),
      ).toHaveAttribute("href", "/projects");
    }
  });

  test("each tab carries its own glyph", () => {
    renderShell(owner);
    const glyphs = within(tabNav())
      .getAllByRole("link")
      .map((link) => link.querySelector("svg")?.getAttribute("class"));
    for (const [index, icon] of [
      "lucide-activity",
      "lucide-package",
      "lucide-folder",
      "lucide-users",
      "lucide-messages-square",
      "lucide-user",
    ].entries()) {
      expect(glyphs[index]).toContain(icon);
    }
  });

  test("under the Products label, one row per visible product: key in mono, then name", () => {
    renderShell(owner);
    const row = within(productsNav()).getByRole("link", { name: "TRL trail" });
    expect(row).toHaveAttribute("href", "/products/TRL");
    expect(within(row).getByText("TRL")).toHaveClass("font-mono");
    expect(
      within(productsNav()).getByRole("heading", { name: "Products" }),
    ).toBeInTheDocument();
  });

  test("a viewer with no product has no Products list", () => {
    render(
      <ThemeProvider>
        <AppShell
          viewer={owner}
          products={[]}
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
    expect(
      screen.queryByRole("navigation", { name: "Products" }),
    ).not.toBeInTheDocument();
  });
});

describe("where the page sits", () => {
  test("a product page marks its own row, not Products, in the sidebar", () => {
    renderAt({ section: "products", productKey: "TRL" });
    expect(
      within(sidebarNav()).getByRole("link", { name: "Products" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(productsNav()).getByRole("link", { name: "TRL trail" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(tabNav()).getByRole("link", { name: "Products" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("an item page marks its product's row and the Products tab as its location", () => {
    renderAt({ section: null, productKey: "TRL" });
    expect(
      within(productsNav()).getByRole("link", { name: "TRL trail" }),
    ).toHaveAttribute("aria-current", "location");
    expect(
      within(productsNav()).getByRole("link", { name: "OPB OpenBot" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(sidebarNav()).getByRole("link", { name: "Products" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(tabNav()).getByRole("link", { name: "Products" }),
    ).toHaveAttribute("aria-current", "location");
    expect(
      within(tabNav()).getByRole("link", { name: "Projects" }),
    ).not.toHaveAttribute("aria-current");
  });

  test("the products list marks Products; a projects page marks Projects", () => {
    renderAt({ section: "products" });
    for (const nav of mainNavs()) {
      expect(
        within(nav).getByRole("link", { name: "Products" }),
      ).toHaveAttribute("aria-current", "page");
    }
    cleanup();
    renderAt({ section: "projects" });
    for (const nav of mainNavs()) {
      expect(
        within(nav).getByRole("link", { name: "Projects" }),
      ).toHaveAttribute("aria-current", "page");
      expect(
        within(nav).getByRole("link", { name: "Products" }),
      ).not.toHaveAttribute("aria-current");
    }
  });
});

test("back: a chevron link in the top bar, beside the heading", () => {
  renderAt({
    section: null,
    productKey: "TRL",
    back: { href: "/products/TRL", label: "Back to trail" },
  });
  expect(screen.getByRole("link", { name: "Back to trail" })).toHaveAttribute(
    "href",
    "/products/TRL",
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
        products={[]}
        section={null}
        heading="TRL-14"
        headingKind="breadcrumb"
        back={{ href: "/products/TRL", label: "Back to trail" }}
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

// a link's 2px focus ring sits 2px outside it, where any clipping ancestor cuts it
test("a breadcrumb link's focus ring is clipped by nothing in the bar; a long crumb still truncates", async () => {
  const productName = "Customer onboarding and billing reconciliation";
  const { container } = render(
    <ThemeProvider>
      <AppShell
        viewer={owner}
        products={[]}
        section={null}
        heading={
          <IssueBreadcrumb
            issueKey="TRL-14"
            product={{ key: "TRL", name: productName }}
          />
        }
        headingKind="breadcrumb"
        back={{ href: "/products/TRL", label: "Back to trail" }}
        onSearch={vi.fn()}
        onNewIssue={vi.fn()}
        onSignOut={vi.fn()}
      >
        <h1>Team access</h1>
      </AppShell>
    </ThemeProvider>,
  );
  onTestFinished(await applyCompiledCss(container));
  const navs = screen.getAllByRole("navigation", {
    name: "Breadcrumb",
    hidden: true,
  });
  expect(navs).toHaveLength(2);
  for (const nav of navs) {
    const link = within(nav).getByRole("link", {
      name: productName,
      hidden: true,
    });
    const clipping: string[] = [];
    const header = link.closest("header");
    for (let el = link.parentElement; el; el = el.parentElement) {
      if (getComputedStyle(el).overflow !== "visible") {
        clipping.push(`<${el.localName} class="${el.className}">`);
      }
      if (el === header) break;
    }
    expect(clipping).toEqual([]);
    const crumb = getComputedStyle(link);
    expect(crumb.overflow).toBe("hidden");
    expect(crumb.textOverflow).toBe("ellipsis");
    expect(crumb.whiteSpace).toBe("nowrap");
  }
});

/** Every ancestor of `el` up to its header that clips overflow, as a printable list. */
function clippingAncestors(el: Element): string[] {
  const clipping: string[] = [];
  const header = el.closest("header");
  for (let at = el.parentElement; at; at = at.parentElement) {
    if (getComputedStyle(at).overflow !== "visible") {
      clipping.push(`<${at.localName} class="${at.className}">`);
    }
    if (at === header) break;
  }
  return clipping;
}

function expectEllipsis(el: Element) {
  const style = getComputedStyle(el);
  expect(style.overflow).toBe("hidden");
  expect(style.textOverflow).toBe("ellipsis");
  expect(style.whiteSpace).toBe("nowrap");
}

function renderTitled(heading: ReactNode) {
  return render(
    <ThemeProvider>
      <AppShell
        viewer={owner}
        products={[]}
        section={null}
        heading={heading}
        onSearch={vi.fn()}
        onNewIssue={vi.fn()}
        onSignOut={vi.fn()}
      >
        <p>page</p>
      </AppShell>
    </ThemeProvider>,
  );
}

const longName = "Customer onboarding and billing reconciliation";

describe("a title heading in the top bar at lg", () => {
  test.each([
    [
      "Products",
      "a product's",
      <ProductHeading key="p" product={{ key: "ALPHA", name: longName }} />,
    ],
    [
      "Projects",
      "a project's",
      <ProjectHeading key="p" project={{ name: longName }} />,
    ],
  ])(
    "the %s link's focus ring is clipped by nothing; %s long name still ends in an ellipsis",
    async (linkName, _, heading) => {
      const { container } = renderTitled(heading);
      onTestFinished(await applyCompiledCss(container));
      const header = container.querySelector("header") as HTMLElement;
      const h1 = within(header).getByRole("heading", { level: 1 });
      const link = within(h1).getByRole("link", { name: linkName });
      expect(clippingAncestors(link)).toEqual([]);
      expectEllipsis(within(h1).getByText(longName));
    },
  );

  test("a plain title clips nothing around it and still ends in an ellipsis", async () => {
    const { container } = renderTitled(longName);
    onTestFinished(await applyCompiledCss(container));
    const header = container.querySelector("header") as HTMLElement;
    const h1 = within(header).getByRole("heading", { level: 1 });
    expect(getComputedStyle(h1).overflow).toBe("visible");
    expect(getComputedStyle(h1).minWidth).toBe("0px");
    const text = within(h1).getByText(longName);
    expect(text).not.toBe(h1);
    expectEllipsis(text);
  });
});

// jsdom matches media queries against its 1024px window: lg, not xl
test("at 1024px a long issue breadcrumb fits its bar column: Products drops, the name truncates, the key stays whole", async () => {
  expect(window.innerWidth).toBe(1024);
  const { container } = render(
    <ThemeProvider>
      <AppShell
        viewer={owner}
        products={[]}
        section={null}
        heading={
          <IssueBreadcrumb
            issueKey="PLATFORMXX-1234"
            product={{ key: "PLATFORMXX", name: longName }}
          />
        }
        headingKind="breadcrumb"
        onSearch={vi.fn()}
        onNewIssue={vi.fn()}
        onSignOut={vi.fn()}
      >
        <h1>Team access</h1>
      </AppShell>
    </ThemeProvider>,
  );
  onTestFinished(await applyCompiledCss(container));
  const header = container.querySelector("header") as HTMLElement;
  const nav = within(header).getByRole("navigation", { name: "Breadcrumb" });
  // the bar column, the nav and the crumb row may all shrink below their content
  const column = nav.parentElement as HTMLElement;
  const crumb = nav.firstElementChild as HTMLElement;
  for (const el of [column, nav, crumb]) {
    expect(getComputedStyle(el).minWidth).toBe("0px");
  }
  expect(clippingAncestors(crumb)).toEqual([]);

  const products = within(nav).getByText("Products");
  expect(getComputedStyle(products).display).toBe("none");
  const slashes = [...nav.querySelectorAll("[aria-hidden='true']")].filter(
    (el) => el.textContent?.trim() === "/",
  );
  expect(slashes).toHaveLength(2);
  const [afterProducts, afterName] = slashes as [Element, Element];
  expect(getComputedStyle(afterProducts).display).toBe("none");
  expect(getComputedStyle(afterName).display).not.toBe("none");

  const name = within(nav).getByRole("link", { name: longName });
  expect(getComputedStyle(name).minWidth).toBe("0px");
  expectEllipsis(name);

  const key = within(nav).getByText("PLATFORMXX-1234");
  expect(getComputedStyle(key).flexShrink).toBe("0");
  expect(getComputedStyle(key).whiteSpace).toBe("nowrap");
});

/** The mark's svg (three pills) and the wordmark beside it, inside `scope`. */
function expectLogoIn(scope: HTMLElement) {
  const mark = scope.querySelector(
    "svg[aria-hidden='true'][viewBox='0 4 60 52']",
  );
  expect(mark?.querySelectorAll("rect")).toHaveLength(3);
  expect(mark?.nextElementSibling).toHaveTextContent("trail.");
}

describe("the logo", () => {
  test("the sidebar and the top bar each carry the mark and wordmark", () => {
    renderShell(owner);
    expectLogoIn(sidebarNav().closest("aside") as HTMLElement);
    expectLogoIn(screen.getByRole("banner"));
  });

  test("a page with a back link has no logo in the top bar; the sidebar keeps its own", () => {
    renderAt({
      section: null,
      productKey: "TRL",
      back: { href: "/products/TRL", label: "Back to trail" },
    });
    expect(
      screen.getByRole("banner").querySelector("svg[viewBox='0 4 60 52']"),
    ).toBeNull();
    expectLogoIn(sidebarNav().closest("aside") as HTMLElement);
  });
});
