import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ProjectView, type ProjectViewProps } from "@/components/project";
import { issueList, issueRow, statusUpdate, trail } from "@/test/fixtures";

const now = new Date("2026-11-11T12:00:00.000Z");

function renderProject(overrides: Partial<ProjectViewProps> = {}) {
  const props: ProjectViewProps = {
    project: trail,
    issues: {
      status: "ready",
      data: issueList([
        issueRow(),
        issueRow({
          key: "TRL-11",
          title: "Board view for the issue list",
          status: "canceled",
          priority: 0,
          labels: [],
          assignee: null,
        }),
      ]),
    },
    statusUpdates: {
      status: "ready",
      data: { items: [statusUpdate()], nextCursor: null },
    },
    status: null,
    onStatusChange: vi.fn(),
    onNewIssue: vi.fn(),
    onRetryIssues: vi.fn(),
    onRetryStatusUpdates: vi.fn(),
    now,
    ...overrides,
  };
  render(<ProjectView {...props} />);
  return props;
}

describe("status filter", () => {
  test("every tab shows its count and All is selected by default", () => {
    renderProject();
    const tabs = screen.getByRole("tablist", { name: "Filter by status" });
    expect(within(tabs).getByRole("tab", { name: "All 38" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    for (const name of ["Open 9", "In progress 3", "Done 24", "Canceled 2"]) {
      expect(within(tabs).getByRole("tab", { name })).toBeInTheDocument();
    }
  });

  test("selecting a tab calls onStatusChange with that status, and All with null", async () => {
    const user = userEvent.setup();
    const props = renderProject();
    const tabs = screen.getByRole("tablist", { name: "Filter by status" });
    await user.click(within(tabs).getByRole("tab", { name: "In progress 3" }));
    expect(props.onStatusChange).toHaveBeenLastCalledWith("in_progress");
  });

  test("All calls onStatusChange with null from a filtered list", async () => {
    const user = userEvent.setup();
    const props = renderProject({ status: "done" });
    const tabs = screen.getByRole("tablist", { name: "Filter by status" });
    await user.click(within(tabs).getByRole("tab", { name: "All 38" }));
    expect(props.onStatusChange).toHaveBeenLastCalledWith(null);
  });

  test("the 375 chips carry the same filter", async () => {
    const user = userEvent.setup();
    const props = renderProject();
    const chips = screen.getByRole("group", { name: "Filter by status" });
    expect(
      within(chips).getByRole("button", { name: "All 38" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(within(chips).getByRole("button", { name: "Done 24" }));
    expect(props.onStatusChange).toHaveBeenLastCalledWith("done");
  });

  test('a status with no issues says "No issues are in progress" and Show all clears the filter', async () => {
    const user = userEvent.setup();
    const props = renderProject({
      status: "in_progress",
      issues: { status: "ready", data: issueList([], { in_progress: 0 }) },
    });
    expect(
      screen.getByRole("heading", { name: "No issues are in progress" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(props.onStatusChange).toHaveBeenCalledWith(null);
  });

  test("a project with no issues at all offers New issue", async () => {
    const user = userEvent.setup();
    const props = renderProject({
      issues: {
        status: "ready",
        data: issueList([], {
          all: 0,
          open: 0,
          in_progress: 0,
          done: 0,
          canceled: 0,
        }),
      },
    });
    expect(
      screen.getByRole("heading", { name: "No issues in TRL yet" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New issue" }));
    expect(props.onNewIssue).toHaveBeenCalledOnce();
  });

  test("a failed list says so and retries", async () => {
    const user = userEvent.setup();
    const props = renderProject({ issues: { status: "error" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load issues");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetryIssues).toHaveBeenCalledOnce();
  });
});

describe("issue list", () => {
  test("no row offers a control for status, priority, labels or assignee", () => {
    renderProject();
    for (const role of [
      "combobox",
      "listbox",
      "menu",
      "textbox",
      "checkbox",
      "spinbutton",
    ]) {
      expect(screen.queryAllByRole(role), role).toEqual([]);
    }
  });

  test("each row opens its issue", () => {
    renderProject();
    for (const link of screen.getAllByRole("link", {
      name: "TRL-17 Human UI: feed, projects, issue page",
    })) {
      expect(link).toHaveAttribute("href", "/issues/TRL-17");
    }
  });

  test("below 1024px the whole row is the link, described by its status, priority and age", () => {
    renderProject();
    const item = document.querySelector('ul [data-issue-key="TRL-17"]');
    if (!(item instanceof HTMLElement)) throw new Error("no 375 row");
    const link = within(item).getByRole("link", {
      name: "TRL-17 Human UI: feed, projects, issue page",
    });
    expect(link).toHaveAttribute("href", "/issues/TRL-17");
    expect(link).toContainElement(within(item).getByText("Open"));
    expect(link).toHaveAccessibleDescription(
      /^Open .*ui design Assigned to Tara, Bot 1h$/,
    );
  });

  test("the icon-only priority and status glyphs are named", () => {
    renderProject();
    expect(screen.getAllByRole("img", { name: "High" }).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByRole("img", { name: "Canceled" })).toBeInTheDocument();
  });

  test("priority None is a dash, not a signal glyph", () => {
    renderProject();
    const row = screen
      .getByRole("table")
      .querySelector('[data-issue-key="TRL-11"]');
    if (!(row instanceof HTMLElement)) throw new Error("no TRL-11 row");
    expect(within(row).getByText("None")).toBeInTheDocument();
    expect(row.querySelector("svg.lucide-minus")).not.toBeNull();
    expect(row.querySelector('svg[class*="lucide-signal"]')).toBeNull();
  });

  test("a canceled row's title is muted", () => {
    renderProject();
    const [title] = screen.getAllByRole("link", { name: /^TRL-11 / });
    expect(title).toHaveClass("text-muted-foreground");
  });

  test("the assignee carries the bot badge", () => {
    renderProject();
    const row = screen
      .getByRole("table")
      .querySelector('[data-issue-key="TRL-17"]');
    if (!(row instanceof HTMLElement)) throw new Error("no TRL-17 row");
    expect(within(row).getByText("Tara")).toBeInTheDocument();
    expect(within(row).getByText("Bot")).toBeInTheDocument();
  });
});

describe("status updates", () => {
  test("show the author, badge, health and absolute time", () => {
    renderProject();
    const section = screen.getByRole("region", { name: "Status updates" });
    expect(within(section).getByText("Tara")).toBeInTheDocument();
    expect(within(section).getByText("Bot")).toBeInTheDocument();
    expect(within(section).getByText("On track")).toBeInTheDocument();
    expect(
      within(section).getByText(/^Nov 11, \d{2}:\d{2}$/),
    ).toBeInTheDocument();
  });

  test("the 375 switch picks Issues or Status updates", async () => {
    const user = userEvent.setup();
    renderProject();
    const views = screen.getByRole("group", { name: "Show" });
    const updates = within(views).getByRole("button", {
      name: "Status updates",
    });
    expect(updates).toHaveAttribute("aria-pressed", "false");
    await user.click(updates);
    expect(updates).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("region", { name: "Status updates" }),
    ).not.toHaveClass("max-lg:hidden");
  });
});
