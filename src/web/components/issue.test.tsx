import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { IssueView, type IssueViewProps } from "@/components/issue";
import { issue } from "@/test/fixtures";

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
    expect(within(props).getByText("Kai")).toBeInTheDocument();
    expect(within(props).getByText("Bot")).toBeInTheDocument();
    expect(within(props).getByText("auth")).toBeInTheDocument();
    expect(
      within(props).getByRole("link", { name: "TRL trail" }),
    ).toHaveAttribute("href", "/projects/TRL");
  });

  test("a link row shows its title and its URL in mono, and opens safely", () => {
    renderIssue();
    const links = screen.getByRole("region", { name: "Links" });
    const link = within(links).getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/ap-justin/trail/pull/31",
    );
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      within(link).getByText("github.com/ap-justin/trail/pull/31"),
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
            { url: "https://github.com/ap-justin/trail/pull/31", title: "PR" },
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
    ).toEqual(["https://github.com/ap-justin/trail/pull/31"]);
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
    expect(created).toHaveTextContent("created this issue");
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
