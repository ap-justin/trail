import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  IssueBreadcrumb,
  IssueView,
  type IssueViewProps,
} from "@/components/issue";
import {
  alpha,
  beta,
  commentEntry,
  humanUi,
  issue,
  maya,
  note,
  teamAccess,
  todo,
} from "@/test/fixtures";

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

const focusRing = [
  "focus-visible:outline-2",
  "focus-visible:outline-offset-2",
  "focus-visible:outline-ring",
];

const absoluteTime = /^[A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2}$/;

/** TRL-15 as a todo whose created entry says Alpha filed it as an issue. */
function acceptedAsTodo() {
  const base = todo();
  return todo({
    timeline: base.timeline.map((e) =>
      e.kind === "item_created" ? { ...e, createdAs: "issue" as const } : e,
    ),
  });
}

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

  test("show status, priority, estimate, assignee with avatar, labels and project", () => {
    renderIssue();
    const props = screen.getByRole("region", { name: "Properties" });
    expect(within(props).getByText("In progress")).toBeInTheDocument();
    expect(within(props).getByText("High")).toBeInTheDocument();
    expect(within(props).getByText("6 h")).toBeInTheDocument();
    expect(within(props).getByText("Alpha")).toBeInTheDocument();
    expect(
      within(props).getByRole("img", { name: "Alpha, bot" }),
    ).toBeInTheDocument();
    expect(within(props).queryByText("Bot")).toBeNull();
    expect(within(props).getByText("auth")).toBeInTheDocument();
    expect(
      within(props).getByRole("link", { name: "TRL trail" }),
    ).toHaveAttribute("href", "/products/TRL");
  });

  test("the product and project links draw the shared focus outline", () => {
    renderIssue({
      issue: { status: "ready", data: issue({ projects: [humanUi] }) },
    });
    const props = screen.getByRole("region", { name: "Properties" });
    const links = within(props).getAllByRole("link");
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveClass(...focusRing);
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

  const pull = (n: number) => `https://github.com/example/trail/pull/${n}`;
  const checkedAt = "2026-11-12T10:00:00.000Z";

  test.each(["/files", "/", "#issuecomment-4242", "/files?w=1#diff-abc"])(
    "a pull request link ending in %s the server sent no state for reads State unknown",
    (suffix) => {
      renderIssue({
        issue: {
          status: "ready",
          data: issue({ links: [{ url: pull(12) + suffix, title: "PR" }] }),
        },
      });
      expect(
        within(screen.getByRole("region", { name: "Links" })).getByRole("link"),
      ).toHaveAccessibleName(/^Pull request State unknown PR/);
    },
  );

  test.each([
    ["open", "Open", "lucide-git-pull-request"],
    ["draft", "Draft", "lucide-git-pull-request-draft"],
    ["merged", "Merged", "lucide-git-merge"],
    ["closed", "Closed", "lucide-git-pull-request-closed"],
  ] as const)(
    "a %s pull request reads %s with its glyph, in a name that says Pull request",
    (state, word, glyph) => {
      renderIssue({
        issue: {
          status: "ready",
          data: issue({
            links: [
              { url: pull(7), title: "Invite API", pr: { state, checkedAt } },
            ],
          }),
        },
      });
      const links = screen.getByRole("region", { name: "Links" });
      const link = within(links).getByRole("link", {
        name: `Pull request ${word} Invite API github.com/example/trail/pull/7`,
      });
      expect(within(link).getByText(word)).toBeInTheDocument();
      const icon = link.querySelector("svg");
      expect(icon).toHaveClass(glyph);
      expect(icon).toHaveAttribute("aria-hidden", "true");
    },
  );

  test("a pull request trail has no state for yet, or one the server left unread, reads State unknown", () => {
    renderIssue({
      issue: {
        status: "ready",
        data: issue({
          links: [
            { url: pull(8), title: "Private repo PR", pr: null },
            { url: pull(9), title: "Unread PR" },
          ],
        }),
      },
    });
    const links = screen.getByRole("region", { name: "Links" });
    const rows = within(links).getAllByRole("link");
    expect(rows.map((a) => a.textContent)).toEqual([
      "Pull request State unknown Private repo PR github.com/example/trail/pull/8",
      "Pull request State unknown Unread PR github.com/example/trail/pull/9",
    ]);
    for (const row of rows) {
      expect(row.querySelector("svg")).toHaveClass("lucide-git-pull-request");
    }
  });

  test("hovering a pull request row underlines its title only, not the state word or URL", () => {
    renderIssue({
      issue: {
        status: "ready",
        data: issue({
          links: [
            {
              url: pull(7),
              title: "Invite API",
              pr: { state: "merged", checkedAt },
            },
          ],
        }),
      },
    });
    const link = within(
      screen.getByRole("region", { name: "Links" }),
    ).getByRole("link");
    expect(link).toHaveClass("group");
    expect(link).not.toHaveClass("hover:underline");
    expect(within(link).getByText("Invite API")).toHaveClass(
      "group-hover:underline",
    );
    expect(within(link).getByText("Merged")).not.toHaveClass(
      "group-hover:underline",
    );
    expect(
      within(link).getByText("github.com/example/trail/pull/7"),
    ).not.toHaveClass("group-hover:underline");
  });

  test("several pull requests stack in the order they were added, each with its own state", () => {
    renderIssue({
      issue: {
        status: "ready",
        data: issue({
          links: [
            { url: pull(31), title: "B", pr: { state: "merged", checkedAt } },
            { url: pull(29), title: "A", pr: { state: "closed", checkedAt } },
          ],
        }),
      },
    });
    const links = screen.getByRole("region", { name: "Links" });
    const rows = within(links).getAllByRole("link");
    expect(rows.map((a) => a.getAttribute("href"))).toEqual([
      pull(31),
      pull(29),
    ]);
    expect(rows.map((a) => a.textContent)).toEqual([
      "Pull request Merged B github.com/example/trail/pull/31",
      "Pull request Closed A github.com/example/trail/pull/29",
    ]);
    expect(rows[0]?.querySelector("svg")).toHaveClass("lucide-git-merge");
    expect(rows[1]?.querySelector("svg")).toHaveClass(
      "lucide-git-pull-request-closed",
    );
  });

  test.each([
    "https://github.com/example/trail/pull/0",
    "https://github.com/example/../pull/7",
    "http://github.com/example/trail/pull/7",
    "https://github.com/example/trail/pull/12x",
    "https://github.com/example/trail/pull/12.diff",
    "https://github.com/example/trail/pulls/12",
    "https://github.com/example/trail/pull/",
  ])("a pr-less link to %s is not read as a pull request", (url) => {
    renderIssue({
      issue: {
        status: "ready",
        data: issue({ links: [{ url, title: "Not a PR" }] }),
      },
    });
    const links = screen.getByRole("region", { name: "Links" });
    expect(within(links).getByText("Not a PR")).toBeInTheDocument();
    expect(within(links).queryByText("State unknown")).toBeNull();
  });

  test("a pr-less pull request url in any case reads State unknown", () => {
    renderIssue({
      issue: {
        status: "ready",
        data: issue({
          links: [
            { url: "https://GitHub.com/Example/Trail/pull/7", title: "Shouty" },
          ],
        }),
      },
    });
    const links = screen.getByRole("region", { name: "Links" });
    expect(within(links).getByText("State unknown")).toBeInTheDocument();
  });

  test("a link that is not a pull request keeps its plain row, with no state line", () => {
    renderIssue({
      issue: {
        status: "ready",
        data: issue({
          links: [
            { url: "https://example.com/spec", title: "Spec" },
            { url: "https://github.com/example/trail/issues/4", title: "Bug" },
          ],
        }),
      },
    });
    const links = screen.getByRole("region", { name: "Links" });
    expect(within(links).queryByText(/Pull request/)).toBeNull();
    expect(
      within(links).queryByText(/^(Open|Draft|Merged|Closed|State unknown)$/),
    ).toBeNull();
    const spec = within(links).getByText("Spec").closest("a");
    expect(spec?.querySelector("svg")).toHaveClass("text-muted-foreground");
    expect(
      within(spec as HTMLElement).getByText("example.com/spec"),
    ).toHaveClass("font-mono");
  });
});

describe("long comments", () => {
  const line = 19;
  let linesPerBlock = 1;
  let subpixel = 0;
  let resized: (() => void)[] = [];
  const realObserver = window.ResizeObserver;
  let lineHeight: HTMLStyleElement;

  // jsdom has no layout: each paragraph or list item renders `linesPerBlock` lines of 19px,
  // and a box carrying the clamp renders no taller than 4 of them
  beforeEach(() => {
    linesPerBlock = 1;
    subpixel = 0;
    resized = [];
    lineHeight = document.createElement("style");
    lineHeight.textContent = `[data-entry-id] * { line-height: ${line}px; }`;
    document.head.append(lineHeight);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const blocks = this.querySelectorAll("p, li").length;
        const height = blocks * linesPerBlock * line + subpixel;
        return DOMRect.fromRect({
          height: this.classList.contains("max-h-[4lh]")
            ? Math.min(height, 4 * line)
            : height,
        });
      },
    );
    window.ResizeObserver = class {
      constructor(callback: () => void) {
        resized.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    lineHeight.remove();
    vi.restoreAllMocks();
    window.ResizeObserver = realObserver;
  });

  const paragraphs = (n: number) =>
    Array.from({ length: n }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");

  function renderComments(...bodies: string[]) {
    return renderIssue({
      issue: {
        status: "ready",
        data: issue({
          timeline: bodies.map((body, i) =>
            commentEntry(`c${i}`, `2026-11-1${i}T10:00:00.000Z`, {
              comment: { id: `cc${i}`, body, sourceAuthor: null },
            }),
          ),
        }),
      },
    });
  }

  test("a comment of 6 or more lines collapses behind Show more", () => {
    renderComments(paragraphs(6));
    const button = screen.getByRole("button", {
      name: "Show more of the comment by Alpha",
    });
    expect(button).toHaveTextContent("Show more");
    expect(button).toHaveAttribute("aria-expanded", "false");
    const body = document.getElementById(
      button.getAttribute("aria-controls") ?? "",
    );
    expect(body).toHaveClass("max-h-[4lh]", "overflow-hidden");
    expect(body).toHaveTextContent("Paragraph 6.");
  });

  test("a comment of 5 lines or fewer renders in full with no control", () => {
    renderComments(paragraphs(5), paragraphs(1));
    expect(screen.queryByRole("button", { name: /^Show / })).toBeNull();
    expect(document.querySelector(".max-h-\\[4lh\\]")).toBeNull();
  });

  test("a body a fraction of a pixel under 6 lines still counts as 6", () => {
    subpixel = -0.4;
    renderComments(paragraphs(6));
    expect(screen.getByRole("button", { name: /^Show more/ })).toBeVisible();
  });

  test("a body more than half a pixel under 6 lines is 5 lines and renders in full", () => {
    subpixel = -0.6;
    renderComments(paragraphs(6));
    expect(screen.queryByRole("button", { name: /^Show / })).toBeNull();
  });

  // a real ResizeObserver fires when the measured content resizes (a narrower column, a font
  // landing); relayout() fires it on demand, so a test can show opening and closing leave the count alone
  const relayout = () =>
    act(() => {
      for (const callback of resized) callback();
    });

  test("Show more opens the body, flips the label and aria-expanded, and keeps focus; Show less closes it", async () => {
    const user = userEvent.setup();
    renderComments(paragraphs(7));
    relayout();
    const button = screen.getByRole("button", { name: /^Show more/ });
    const body = document.getElementById(
      button.getAttribute("aria-controls") ?? "",
    );

    await user.click(button);
    relayout();
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAccessibleName("Show less of the comment by Alpha");
    expect(button).toHaveTextContent("Show less");
    expect(button).toHaveFocus();
    expect(body).not.toHaveClass("max-h-[4lh]");

    await user.keyboard("{Enter}");
    relayout();
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(body).toHaveClass("max-h-[4lh]");
    await user.keyboard(" ");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveFocus();
  });

  test("tabbing onto a link the clamp hides opens the comment", async () => {
    const user = userEvent.setup();
    renderComments(
      `${paragraphs(6)}\n\nSee [the spec](https://example.com/spec).`,
    );
    const button = screen.getByRole("button", { name: /^Show more/ });
    const link = screen.getByRole("link", { name: "the spec" });
    for (let i = 0; i < 50 && document.activeElement !== link; i++) {
      await user.tab();
    }
    expect(link).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  function renderVisibleLink() {
    const view = renderComments(
      `See [the spec](https://example.com/spec).\n\n${paragraphs(6)}`,
    );
    const link = screen.getByRole("link", { name: "the spec" });
    // jsdom can't open a new tab and logs "Not implemented" when asked to
    link.addEventListener("click", (e) => e.preventDefault());
    return {
      view,
      button: screen.getByRole("button", { name: /^Show more/ }),
      link,
    };
  }

  test("clicking a link in the visible lines focuses it and leaves the comment collapsed", async () => {
    const user = userEvent.setup();
    const { button, link } = renderVisibleLink();
    await user.click(link);
    expect(link).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  test("coming back to the window with focus on a link in the visible lines leaves the comment collapsed", async () => {
    const user = userEvent.setup();
    const { button, link } = renderVisibleLink();
    await user.click(link);
    // the link opened a new tab: the window loses focus, then regains it and re-focuses the link
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.focusOut(link);
    hasFocus.mockReturnValue(true);
    fireEvent.focusIn(link);
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  test("a link that lost focus inside the window still opens the comment when Tab returns to it", async () => {
    const user = userEvent.setup();
    const { button, link } = renderVisibleLink();
    await user.click(link);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => link.blur());
    expect(button).toHaveAttribute("aria-expanded", "false");
    act(() => link.focus());
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  test("after the window comes back with focus elsewhere, Tab onto the link that left with it opens the comment", async () => {
    const user = userEvent.setup();
    const { button, link } = renderVisibleLink();
    await user.click(link);
    // the window loses focus to the address bar, then Tab comes back in onto the next control
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => link.blur());
    hasFocus.mockReturnValue(true);
    act(() => button.focus());
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.tab({ shift: true });
    expect(link).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  // the return listener ends with its AbortSignal; the focusin signals handed to document, in order
  function watchReturnListeners() {
    const signals: AbortSignal[] = [];
    const add = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation(
      (type: string, listener: unknown, options?: unknown) => {
        const signal = (options as AddEventListenerOptions | undefined)?.signal;
        if (type === "focusin" && signal) signals.push(signal);
        add(
          type,
          listener as EventListener,
          options as AddEventListenerOptions,
        );
      },
    );
    return signals;
  }

  test("unmounting a comment with the window-return listener pending removes the listener", async () => {
    const user = userEvent.setup();
    const { view, link } = renderVisibleLink();
    await user.click(link);
    const signals = watchReturnListeners();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.focusOut(link);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    view.unmount();
    expect(signals[0]?.aborted).toBe(true);
  });

  test("a second window-leave replaces the pending return listener instead of stacking another", async () => {
    const user = userEvent.setup();
    const { link } = renderVisibleLink();
    await user.click(link);
    const signals = watchReturnListeners();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    fireEvent.focusOut(link);
    fireEvent.focusOut(link);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  test("tapping a link in the visible lines leaves the comment collapsed", async () => {
    const user = userEvent.setup();
    const { button, link } = renderVisibleLink();
    // touch sends pointerup before the compat mousedown that focuses the link
    await user.pointer({ keys: "[TouchA]", target: link });
    expect(link).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  test("a press that ends outside the body doesn't stop Tab opening it", async () => {
    const user = userEvent.setup();
    renderComments(
      `${paragraphs(6)}\n\nSee [the spec](https://example.com/spec).`,
    );
    const button = screen.getByRole("button", { name: /^Show more/ });
    const link = screen.getByRole("link", { name: "the spec" });
    await user.pointer([
      { keys: "[MouseLeft>]", target: screen.getByText("Paragraph 1.") },
      { target: button },
      { keys: "[/MouseLeft]" },
    ]);
    for (let i = 0; i < 50 && document.activeElement !== link; i++) {
      await user.tab();
    }
    expect(link).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  test("Show less scrolls its button into view; mounting and Show more do not", async () => {
    const user = userEvent.setup();
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    renderComments(paragraphs(7));
    const button = screen.getByRole("button", { name: /^Show more/ });
    expect(scrolled).not.toHaveBeenCalled();

    await user.click(button);
    expect(scrolled).not.toHaveBeenCalled();

    await user.click(button);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrolled.mock.contexts[0]).toBe(button);
  });

  test("each comment keeps its own state: opening one leaves the others", async () => {
    const user = userEvent.setup();
    renderComments(paragraphs(6), paragraphs(2), paragraphs(8));
    const [first, last] = screen.getAllByRole("button", {
      name: /^Show more/,
    });
    await user.click(first as HTMLElement);
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(last).toHaveAttribute("aria-expanded", "false");
    expect(screen.getAllByRole("button", { name: /^Show / })).toHaveLength(2);
  });

  test("re-measures when the body resizes: a comment that wraps past 5 lines gains the control", () => {
    renderComments(paragraphs(3));
    expect(screen.queryByRole("button", { name: /^Show / })).toBeNull();
    linesPerBlock = 2;
    relayout();
    expect(screen.getByRole("button", { name: /^Show more/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
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

  test("every entry carries an avatar named for its kind, no kind pill, and an absolute Mon D, HH:mm time", () => {
    renderIssue();
    for (const entry of entries()) {
      expect(
        within(entry).getByRole("img", { name: /, (bot|person)$/ }),
      ).toBeInTheDocument();
      expect(within(entry).queryByText(/^(Bot|Human)$/)).toBeNull();
      const times = entry.querySelectorAll("time");
      expect(times.length).toBeGreaterThan(0);
      for (const time of times) expect(time.textContent).toMatch(absoluteTime);
    }
  });

  test("comments sit in a flat well and changes are one line with the change in words", () => {
    renderIssue();
    const [created, priority, comment, status] = entries();
    expect(created).toHaveTextContent("filed this issue");
    expect(priority).toHaveTextContent("set priority to High");
    expect(comment).toHaveClass("bg-muted");
    expect(comment).not.toHaveClass("border");
    expect(comment).toHaveTextContent("Owner only for invites.");
    expect(status).toHaveTextContent("changed status from Open to In progress");
  });

  test("accepting an issue reads as a change from Triage, not Open to Open", () => {
    const base = issue();
    renderIssue({
      issue: {
        status: "ready",
        data: {
          ...base,
          timeline: base.timeline.map((e) =>
            e.kind === "status_changed"
              ? { ...e, from: "triage", to: "open" }
              : e,
          ),
        },
      },
    });
    const status = entries().at(-1);
    expect(status).toHaveTextContent("changed status from Triage to Open");
  });

  test("a change into triage reads to Triage, not Open", () => {
    const base = issue();
    renderIssue({
      issue: {
        status: "ready",
        data: {
          ...base,
          timeline: base.timeline.map((e) =>
            e.kind === "status_changed"
              ? { ...e, from: "open", to: "triage" }
              : e,
          ),
        },
      },
    });
    const status = entries().at(-1);
    expect(status).toHaveTextContent("changed status from Open to Triage");
  });

  test("comments have no edit or delete", () => {
    renderIssue();
    const [, , comment] = entries();
    if (!comment) throw new Error("no comment");
    expect(within(comment).queryAllByRole("button")).toEqual([]);
  });
});

describe("comment box", () => {
  test("Comment is aria-disabled with its reason while the box is empty or only whitespace", async () => {
    const user = userEvent.setup();
    renderIssue();
    const button = screen.getByRole("button", { name: "Comment" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("Write something to post it");
    // focusable while held, so the reason is read where the operator stands
    expect(button).toBeEnabled();
    await user.type(screen.getByRole("textbox", { name: "Comment" }), "   ");
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.type(
      screen.getByRole("textbox", { name: "Comment" }),
      "Looks right",
    );
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText("Write something to post it")).toBeNull();
  });

  test("an empty box posts nothing", async () => {
    const user = userEvent.setup();
    const { props } = renderIssue();
    screen.getByRole("button", { name: "Comment" }).focus();
    await user.keyboard("{Enter}");
    expect(props.onComment).not.toHaveBeenCalled();
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

  test('says "Commenting as {name}" with no kind pill', () => {
    renderIssue();
    const line = screen.getByText(/^Commenting as/);
    expect(line).toHaveTextContent("Commenting as Maya Chen. Markdown works.");
    expect(within(line).queryByText("Human")).toBeNull();
  });

  test("the box is labelled Comment above it, with no placeholder", () => {
    renderIssue();
    const box = screen.getByRole("textbox", { name: "Comment" });
    expect(box).not.toHaveAttribute("placeholder");
    const label = document.querySelector(`label[for="${box.id}"]`);
    expect(label).not.toHaveClass("sr-only");
  });

  test("clears once the comment lands, and keeps the text when it fails", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderIssue();
    const box = screen.getByRole("textbox", { name: "Comment" });
    await user.type(box, "First");
    rerender(<IssueView {...props} commentPending />);
    expect(screen.getByRole("button", { name: "Commenting…" })).toHaveAttribute(
      "aria-busy",
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

describe("reading order", () => {
  test("the description comes before Properties", () => {
    renderIssue();
    const description = screen.getByText("Invited people sign in with GitHub.");
    expect(
      description.compareDocumentPosition(propertiesRegion()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("the header carries the item's status for the phone, where Properties drops it", () => {
    renderIssue();
    const header = screen.getByRole("banner");
    expect(within(header).getByText("In progress")).toHaveClass("lg:hidden");
    expect(
      propertyValue("Status").parentElement?.className.split(" "),
    ).toContain("max-lg:hidden");
  });

  test("at lg the header is one unwrapped column, so the byline sits under the full-width title", () => {
    renderIssue();
    // a wrapping column breaks the basis-full title and the byline into side-by-side columns
    expect(screen.getByRole("banner")).toHaveClass(
      "lg:flex-col",
      "lg:flex-nowrap",
    );
  });
});

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

  test("an issue: the inbox glyph and the word Issue in the byline and Type, filed by its creator", () => {
    renderIssue();
    const line = byline();
    for (const type of [
      within(line).getByText("Issue"),
      within(propertyValue("Type")).getByText("Issue"),
    ]) {
      const glyph = type.querySelector("svg");
      expect(glyph).toHaveAttribute("data-item-type", "issue");
      expect(glyph).toHaveClass("lucide-inbox");
    }
    expect(line).toHaveTextContent(/Issue\s*TRL-14\s*filed by.*Beta/);
    expect(within(line).getByRole("img", { name: "Beta, bot" })).toBeVisible();
    expect(within(line).queryByText("Bot")).toBeNull();
  });

  test("a todo: the Todo badge with the list glyph, planned by its creator", () => {
    renderIssue({
      issueKey: "TRL-15",
      issue: { status: "ready", data: todo() },
    });
    const line = byline();
    const glyph = within(line).getByText("Todo").querySelector("svg");
    expect(glyph).toHaveAttribute("data-item-type", "todo");
    expect(glyph).toHaveClass("lucide-list-todo");
    expect(within(propertyValue("Type")).getByText("Todo")).toBeInTheDocument();
    expect(line).toHaveTextContent(/Todo\s*TRL-15\s*planned by.*Alpha/);
  });

  test("a person's issue is filed by them, their avatar named a person", () => {
    renderIssue({ issue: { status: "ready", data: issue({ creator: maya }) } });
    const line = byline();
    expect(line).toHaveTextContent(/filed by.*Maya Chen/);
    expect(
      within(line).getByRole("img", { name: "Maya Chen, person" }),
    ).toBeInTheDocument();
  });

  test("an issue a bot filed and the owner accepted as a todo is still filed by it", () => {
    renderIssue({
      issueKey: "TRL-15",
      issue: { status: "ready", data: acceptedAsTodo() },
    });
    expect(byline()).toHaveTextContent(/Todo\s*TRL-15\s*filed by.*Alpha/);
  });

  test("with no created entry in the timeline, the byline follows the current type", () => {
    renderIssue({
      issueKey: "TRL-15",
      issue: { status: "ready", data: todo({ timeline: [] }) },
    });
    expect(byline()).toHaveTextContent(/Todo\s*TRL-15\s*planned by.*Alpha/);
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

  test("below lg each project's trailing comma sits centred beside its 44px link", () => {
    renderIssue({
      issue: {
        status: "ready",
        data: issue({ projects: [teamAccess, humanUi] }),
      },
    });
    for (const row of within(propertyValue("Projects")).getAllByRole(
      "listitem",
    )) {
      expect(row).toHaveClass(
        "flex",
        "items-center",
        "max-lg:not-last:after:content-[',']",
      );
    }
  });

  test("the Product and Projects links are 44px tap targets below lg", () => {
    renderIssue({
      issue: { status: "ready", data: issue({ projects: [humanUi] }) },
    });
    for (const link of [
      within(propertyValue("Product")).getByRole("link"),
      within(propertyValue("Projects")).getByRole("link"),
    ]) {
      expect(link).toHaveClass("max-lg:min-h-11");
      expect(link).not.toHaveClass("min-h-11");
    }
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
              createdAs: "issue",
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

  test("an issue a bot filed and the owner accepted as a todo opens with filed this issue", () => {
    renderIssue({
      issueKey: "TRL-15",
      issue: { status: "ready", data: acceptedAsTodo() },
    });
    const [created] = [
      ...document.querySelectorAll<HTMLElement>("[data-entry-id]"),
    ];
    expect(created).toHaveTextContent("filed this issue");
    expect(created).not.toHaveTextContent("planned");
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
  for (const link of screen.getAllByRole("link"))
    expect(link).toHaveClass(...focusRing);
});

test("an assignment line shows the assignee's avatar before their name", () => {
  const base = issue();
  renderIssue({
    issue: {
      status: "ready",
      data: issue({
        timeline: [
          {
            product: base.product,
            item: { key: "TRL-14", title: "Team access", type: "issue" },
            project: null,
            kind: "assignee_changed",
            id: "assign",
            createdAt: "2026-11-09T14:03:00.000Z",
            actor: beta,
            from: null,
            to: alpha,
          },
        ],
      }),
    },
  });
  const line = document.querySelector<HTMLElement>('[data-entry-id="assign"]');
  if (!line) throw new Error("no assignment line");
  const avatar = within(line).getByRole("img", { name: "Alpha, bot" });
  const name = within(line).getByText("Alpha");
  expect(
    avatar.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

describe("notes", () => {
  test("a note's page says Note and Current, has no Assignee, and links the items it is about", () => {
    renderIssue({
      issueKey: "TRL-31",
      issue: { status: "ready", data: note() },
    });
    const properties = screen.getByRole("region", { name: "Properties" });
    expect(within(properties).getByText("Note")).toBeInTheDocument();
    expect(within(properties).getByText("Current")).toBeInTheDocument();
    expect(within(properties).queryByText("Assignee")).toBeNull();
    expect(screen.getByText("written by")).toBeInTheDocument();
    const about = screen.getByRole("region", { name: "About" });
    const links = within(about).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/products/TRL/14",
      "/products/TRL/15",
    ]);
    expect(links[0]).toHaveAccessibleName(
      "In progress Issue TRL-14 Team access",
    );
    expect(screen.queryByRole("region", { name: "Notes" })).toBeNull();
  });

  test("a person comments on a note: the box is there and Comment sends the trimmed body", async () => {
    const user = userEvent.setup();
    const { props } = renderIssue({
      issueKey: "TRL-31",
      issue: { status: "ready", data: note() },
    });
    await user.type(
      screen.getByRole("textbox", { name: "Comment" }),
      "  Thanks, this saved me an hour  ",
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(props.onComment).toHaveBeenCalledWith(
      "Thanks, this saved me an hour",
    );
  });

  test("an archived note reads Archived", () => {
    renderIssue({
      issueKey: "TRL-31",
      issue: { status: "ready", data: note({ status: "archived" }) },
    });
    const properties = screen.getByRole("region", { name: "Properties" });
    expect(within(properties).getByText("Archived")).toBeInTheDocument();
  });

  test("its creation reads wrote this note", () => {
    renderIssue({
      issueKey: "TRL-31",
      issue: { status: "ready", data: note() },
    });
    expect(screen.getByText("wrote this note")).toBeInTheDocument();
  });

  test("an item's page lists the notes about it, each a link with its state", () => {
    renderIssue({
      issue: {
        status: "ready",
        data: issue({
          notes: [
            {
              key: "TRL-31",
              title: "Why the feed reads newest first",
              type: "note",
              status: "current",
            },
          ],
          notesCount: { current: 1, archived: 0 },
        }),
      },
    });
    const notes = screen.getByRole("region", { name: "Notes" });
    expect(within(notes).getByRole("link")).toHaveAccessibleName(
      "Current Note TRL-31 Why the feed reads newest first",
    );
    expect(within(notes).queryByText(/Archived notes/)).toBeNull();
    expect(screen.queryByRole("region", { name: "About" })).toBeNull();
  });

  test("a note's properties have no Priority or Estimate", () => {
    renderIssue({
      issueKey: "TRL-31",
      issue: { status: "ready", data: note() },
    });
    expect(termsOf(propertiesRegion())).toEqual([
      "Type",
      "Status",
      "Labels",
      "Product",
      "Projects",
      "Created",
      "Updated",
    ]);
  });

  test("only archived notes about an item: the section says none are current and counts the archived, as text", () => {
    renderIssue({
      issue: {
        status: "ready",
        data: issue({ notes: [], notesCount: { current: 0, archived: 2 } }),
      },
    });
    const notes = screen.getByRole("region", { name: "Notes" });
    expect(within(notes).getByText("No current notes.")).toBeInTheDocument();
    expect(within(notes).getByText("Archived notes 2")).toBeInTheDocument();
    expect(within(notes).queryByRole("link")).toBeNull();
    expect(within(notes).queryByRole("list")).toBeNull();
  });

  test("more current notes than the read carries: the rest are a count", () => {
    const shown = Array.from({ length: 50 }, (_, n) => ({
      key: `TRL-${100 + n}`,
      title: `Note ${n}`,
      type: "note" as const,
      status: "current" as const,
    }));
    renderIssue({
      issue: {
        status: "ready",
        data: issue({
          notes: shown,
          notesCount: { current: 53, archived: 1 },
        }),
      },
    });
    const notes = screen.getByRole("region", { name: "Notes" });
    expect(within(notes).getAllByRole("link")).toHaveLength(50);
    expect(within(notes).getByText("3 more current notes")).toBeInTheDocument();
    expect(within(notes).getByText("Archived notes 1")).toBeInTheDocument();
    expect(within(notes).queryByText("No current notes.")).toBeNull();
  });

  test("an item no note is about has no Notes section", () => {
    renderIssue();
    expect(screen.queryByRole("region", { name: "Notes" })).toBeNull();
  });
});
