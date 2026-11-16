import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import {
  IssueBreadcrumb,
  IssueView,
  type IssueViewProps,
} from "@/components/issue";
import { humanUi, issue, maya, teamAccess, todo } from "@/test/fixtures";

function renderIssue(overrides: Partial<IssueViewProps> = {}) {
  const props: IssueViewProps = {
    issueKey: "TRL-14",
    issue: { status: "ready", data: issue() },
    viewer: { name: "Maya Chen" },
    onRetry: vi.fn(),
    onComment: vi.fn(),
    commentPending: false,
    commentError: null,
    ...overrides,
  };
  const view = render(<IssueView {...props} />);
  return { props, ...view };
}

const absoluteTime = /^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/;

describe("properties", () => {
  test("are plain text: no select, menu or editable field anywhere but the comment box", () => {
    renderIssue();
    for (const role of [
      "combobox",
      "listbox",
      "menu",
      "checkbox",
      "spinbutton",
      "slider",
    ]) {
      expect(screen.queryAllByRole(role), role).toEqual([]);
    }
    expect(screen.getAllByRole("textbox")).toEqual([
      screen.getByRole("textbox", { name: "Comment" }),
    ]);
  });

  test("show status, priority, estimate, assignee with badge, labels and project", () => {
    renderIssue();
    const props = screen.getByRole("region", { name: "Properties" });
    expect(within(props).getByText("In progress")).toBeInTheDocument();
    expect(within(props).getByText("High")).toBeInTheDocument();
    expect(within(props).getByText("6 h")).toBeInTheDocument();
    expect(within(props).getByText("Alpha")).toBeInTheDocument();
    expect(within(props).getByText("Bot")).toBeInTheDocument();
    expect(within(props).getByText("auth")).toBeInTheDocument();
    expect(
      within(props).getByRole("link", { name: "TRL trail" }),
    ).toHaveAttribute("href", "/products/TRL");
  });

  test("a link row shows its title and its URL in mono, and opens safely", () => {
    renderIssue();
    const links = screen.getByRole("region", { name: "Links" });
    const link = within(links).getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/example/trail/pull/31",
    );
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      within(link).getByText("github.com/example/trail/pull/31"),
    ).toHaveClass("font-mono");
  });
});

describe("links", () => {
  test("a non-web URL is shown as text, never a live anchor", () => {
    renderIssue({
      issue: {
        status: "ready",
        data: issue({
          links: [
            { url: "javascript:alert(1)", title: "Totally a PR" },
            { url: "https://github.com/example/trail/pull/31", title: "PR" },
          ],
        }),
      },
    });
    const links = screen.getByRole("region", { name: "Links" });
    expect(within(links).getByText("Totally a PR")).toBeInTheDocument();
    expect(within(links).getByText("javascript:alert(1)")).toBeInTheDocument();
    // the https row beside it is still an anchor, so the absence below is a live read
    expect(
      within(links)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["https://github.com/example/trail/pull/31"]);
    expect(links.querySelector('[href^="javascript:"]')).toBeNull();
  });
});

describe("timeline", () => {
  const entries = () => [
    ...document.querySelectorAll<HTMLElement>("[data-entry-id]"),
  ];

  test("renders oldest first, in the order the server sent", () => {
    renderIssue();
    expect(entries().map((e) => e.dataset.entryId)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
  });

  test("every entry carries a badge and an absolute Mon D, HH:mm time", () => {
    renderIssue();
    for (const entry of entries()) {
      expect(within(entry).getByText(/^(Bot|Human)$/)).toBeInTheDocument();
      const times = entry.querySelectorAll("time");
      expect(times.length).toBeGreaterThan(0);
      for (const time of times) expect(time.textContent).toMatch(absoluteTime);
    }
  });

  test("comments are cards and changes are one line with the change in words", () => {
    renderIssue();
    const [created, priority, comment, status] = entries();
    expect(created).toHaveTextContent("filed this issue");
    expect(priority).toHaveTextContent("set priority to High");
    expect(comment).toHaveClass("rounded-xl", "border");
    expect(comment).toHaveTextContent("Owner only for invites.");
    expect(status).toHaveTextContent("changed status from Open to In progress");
  });

  test("comments have no edit or delete", () => {
    renderIssue();
    const [, , comment] = entries();
    if (!comment) throw new Error("no comment");
    expect(within(comment).queryAllByRole("button")).toEqual([]);
  });
});

describe("comment box", () => {
  test("Comment is disabled while the box is empty or only whitespace", async () => {
    const user = userEvent.setup();
    renderIssue();
    const button = screen.getByRole("button", { name: "Comment" });
    expect(button).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "   ");
    expect(button).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Comment" }),
      "Looks right",
    );
    expect(button).toBeEnabled();
  });

  test("Comment sends the trimmed body", async () => {
    const user = userEvent.setup();
    const { props } = renderIssue();
    await user.type(
      screen.getByRole("textbox", { name: "Comment" }),
      "  Ship it  ",
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(props.onComment).toHaveBeenCalledWith("Ship it");
  });

  test('says "Commenting as {name}" with the Human badge', () => {
    renderIssue();
    const line = screen.getByText(/^Commenting as/);
    expect(line).toHaveTextContent("Commenting as Maya Chen");
    expect(within(line).getByText("Human")).toBeInTheDocument();
  });

  test("the placeholder invites Markdown", () => {
    renderIssue();
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveAttribute(
      "placeholder",
      "Leave a comment. Markdown works.",
    );
  });

  test("clears once the comment lands, and keeps the text when it fails", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderIssue();
    const box = screen.getByRole("textbox", { name: "Comment" });
    await user.type(box, "First");
    rerender(<IssueView {...props} commentPending />);
    expect(screen.getByRole("button", { name: "Commenting…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    rerender(
      <IssueView
        {...props}
        commentPending={false}
        commentError="Couldn't post."
      />,
    );
    expect(box).toHaveValue("First");
    expect(screen.getByText("Couldn't post.")).toBeInTheDocument();
    rerender(<IssueView {...props} commentPending />);
    rerender(
      <IssueView {...props} commentPending={false} commentError={null} />,
    );
    expect(box).toHaveValue("");
  });
});

describe("states", () => {
  test("a failed load names the key and retries", async () => {
    const user = userEvent.setup();
    const { props } = renderIssue({ issue: { status: "error" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load TRL-14");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something went wrong on our side. Try again.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  test("not found reads like any missing page", () => {
    renderIssue({ issue: { status: "not_found" } });
    expect(
      screen.getByRole("heading", { name: "Page not found" }),
    ).toBeInTheDocument();
  });

  test("loading is announced once", () => {
    renderIssue({ issue: { status: "loading" } });
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });
});

/** The line under the title. */
const byline = () => {
  const line = screen.getByRole("heading", { level: 1 }).nextElementSibling;
  if (!(line instanceof HTMLElement)) throw new Error("no byline");
  return line;
};
const propertiesRegion = () =>
  screen.getByRole("region", { name: "Properties" });
const termsOf = (region: HTMLElement) =>
  [...region.querySelectorAll("dt")].map((dt) => dt.textContent);
const propertyValue = (label: string) => {
  const dt = [...propertiesRegion().querySelectorAll("dt")].find(
    (term) => term.textContent === label,
  );
  const dd = dt?.nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`no ${label} value`);
  return dd;
};

describe("item type", () => {
  test("properties run Type, Status, Priority, Estimate, Assignee, Labels, Product, Projects, Created, Updated", () => {
    renderIssue();
    expect(termsOf(propertiesRegion())).toEqual([
      "Type",
      "Status",
      "Priority",
      "Estimate",
      "Assignee",
      "Labels",
      "Product",
      "Projects",
      "Created",
      "Updated",
    ]);
  });

  test("an issue: the Issue badge with the inbox glyph in the byline and Type, filed by its creator", () => {
    renderIssue();
    const line = byline();
    for (const badge of [
      within(line).getByText("Issue"),
      within(propertyValue("Type")).getByText("Issue"),
    ]) {
      expect(badge).toHaveAttribute("data-item-type", "issue");
      expect(badge.querySelector("svg")).toHaveClass("lucide-inbox");
    }
    expect(line).toHaveTextContent(/Issue\s*TRL-14\s*filed by.*Beta/);
    expect(within(line).getByText("Bot")).toBeInTheDocument();
  });

  test("a todo: the Todo badge with the list glyph, planned by its creator", () => {
    renderIssue({
      issueKey: "TRL-15",
      issue: { status: "ready", data: todo() },
    });
    const line = byline();
    const badge = within(line).getByText("Todo");
    expect(badge).toHaveAttribute("data-item-type", "todo");
    expect(badge.querySelector("svg")).toHaveClass("lucide-list-todo");
    expect(within(propertyValue("Type")).getByText("Todo")).toBeInTheDocument();
    expect(line).toHaveTextContent(/Todo\s*TRL-15\s*planned by.*Alpha/);
  });

  test("a person's issue is filed by a Human", () => {
    renderIssue({ issue: { status: "ready", data: issue({ creator: maya }) } });
    const line = byline();
    expect(line).toHaveTextContent(/filed by.*Maya Chen/);
    expect(within(line).getByText("Human")).toBeInTheDocument();
  });

  test("an unassigned issue says Unassigned", () => {
    renderIssue({
      issue: { status: "ready", data: issue({ assignee: null }) },
    });
    expect(propertyValue("Assignee")).toHaveTextContent("Unassigned");
  });

  test("a todo never says Unassigned", () => {
    renderIssue({
      issueKey: "TRL-15",
      issue: { status: "ready", data: todo({ assignee: null }) },
    });
    expect(screen.queryByText("Unassigned")).not.toBeInTheDocument();
    cleanup();
    renderIssue({
      issueKey: "TRL-15",
      issue: { status: "ready", data: todo() },
    });
    expect(propertyValue("Assignee")).toHaveTextContent("Alpha");
    expect(screen.queryByText("Unassigned")).not.toBeInTheDocument();
  });
});

describe("projects property", () => {
  test("one row per project, each with the folder glyph, linking to the project", () => {
    renderIssue({
      issue: {
        status: "ready",
        data: issue({ projects: [teamAccess, humanUi] }),
      },
    });
    const rows = within(propertyValue("Projects")).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Team access",
      "Human UI launch",
    ]);
    for (const row of rows) {
      expect(row.querySelector("svg")).toHaveClass("lucide-folder");
    }
    expect(
      within(propertyValue("Projects")).getByRole("link", {
        name: "Human UI launch",
      }),
    ).toHaveAttribute("href", "/projects/human-ui");
  });

  test("an item in no project reads None, muted", () => {
    renderIssue();
    const none = within(propertyValue("Projects")).getByText("None");
    expect(none).toHaveClass("text-muted-foreground");
    expect(
      within(propertyValue("Projects")).queryAllByRole("listitem"),
    ).toEqual([]);
  });

  test("the product shows its key and name, linking to the product", () => {
    renderIssue();
    const link = within(propertyValue("Product")).getByRole("link", {
      name: "TRL trail",
    });
    expect(within(link).getByText("TRL")).toHaveClass("font-mono");
  });
});

describe("project and type events", () => {
  test("a todo's first event reads planned this todo, then added this to project", () => {
    renderIssue({
      issueKey: "TRL-15",
      issue: { status: "ready", data: todo() },
    });
    const [created, added] = [
      ...document.querySelectorAll<HTMLElement>("[data-entry-id]"),
    ];
    expect(created).toHaveTextContent("planned this todo");
    expect(added).toHaveTextContent("added this to project Human UI launch");
  });

  test("removed from a project, filed by a person, and a type change read in words", () => {
    const base = issue();
    const on = {
      product: base.product,
      item: { key: "TRL-14", title: "Team access", type: "issue" as const },
    };
    renderIssue({
      issue: {
        status: "ready",
        data: issue({
          timeline: [
            {
              ...on,
              project: null,
              kind: "item_created",
              id: "a",
              createdAt: "2026-11-09T14:02:00.000Z",
              actor: maya,
              sourceAuthor: null,
            },
            {
              ...on,
              project: humanUi,
              kind: "removed_from_project",
              id: "b",
              createdAt: "2026-11-09T14:03:00.000Z",
              actor: maya,
            },
            {
              ...on,
              project: null,
              kind: "type_changed",
              id: "c",
              createdAt: "2026-11-09T14:04:00.000Z",
              actor: maya,
              from: "issue",
              to: "todo",
            },
          ],
        }),
      },
    });
    const [filed, removed, typed] = [
      ...document.querySelectorAll<HTMLElement>("[data-entry-id]"),
    ];
    expect(filed).toHaveTextContent("filed this issue");
    expect(removed).toHaveTextContent(
      "removed this from project Human UI launch",
    );
    expect(typed).toHaveTextContent("changed type from Issue to Todo");
  });
});

describe("people's controls", () => {
  test("a todo takes a comment and offers no other control", () => {
    renderIssue({
      issueKey: "TRL-15",
      issue: { status: "ready", data: todo() },
    });
    expect(screen.getAllByRole("textbox")).toEqual([
      screen.getByRole("textbox", { name: "Comment" }),
    ]);
    expect(screen.getAllByRole("button")).toEqual([
      screen.getByRole("button", { name: "Comment" }),
    ]);
  });
});

test("the breadcrumb reads Products / product name / key", () => {
  render(
    <IssueBreadcrumb
      issueKey="TRL-14"
      product={{ key: "TRL", name: "trail" }}
    />,
  );
  expect(screen.getByRole("link", { name: "Products" })).toHaveAttribute(
    "href",
    "/products",
  );
  expect(screen.getByRole("link", { name: "trail" })).toHaveAttribute(
    "href",
    "/products/TRL",
  );
  expect(screen.getByText("TRL-14")).toBeInTheDocument();
});
