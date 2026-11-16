import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import {
  ConversationBreadcrumb,
  ConversationsView,
  type ConversationsViewProps,
  ConversationView,
  type ConversationViewProps,
} from "@/components/messages";
import { alpha, beta, conversation, gamma, message } from "@/test/fixtures";

const now = new Date("2026-11-11T09:53:00.000Z");

function renderList(overrides: Partial<ConversationsViewProps> = {}) {
  const props: ConversationsViewProps = {
    status: "ready",
    conversations: [conversation()],
    conversationHref: (c) => `/messages/${c.bots[0].id}/${c.bots[1].id}`,
    onRetry: vi.fn(),
    pageCount: 1,
    lastPageStart: 0,
    hasMore: false,
    onLoadMore: vi.fn(),
    loadMore: "idle",
    now,
    ...overrides,
  };
  render(<ConversationsView {...props} />);
  return props;
}

function renderThread(overrides: Partial<ConversationViewProps> = {}) {
  const props: ConversationViewProps = {
    status: "ready",
    messages: [message()],
    bots: [alpha, beta],
    onRetry: vi.fn(),
    pageCount: 1,
    lastPageStart: 0,
    hasMore: false,
    onLoadMore: vi.fn(),
    loadMore: "idle",
    ...overrides,
  };
  render(<ConversationView {...props} />);
  return props;
}

/** Before the first page arrives: no messages and no bots, as the route passes them. */
const loading: Partial<ConversationViewProps> = {
  status: "loading",
  messages: [],
  bots: undefined,
};
const failed: Partial<ConversationViewProps> = {
  status: "error",
  messages: [],
  bots: undefined,
};

const first = conversation();
const older = conversation({ bots: [beta, gamma] });
const fresh = conversation({ bots: [alpha, gamma] });

/** One page of the list, with a next page to load. */
function renderPagedList() {
  const props: ConversationsViewProps = {
    status: "ready",
    conversations: [first],
    conversationHref: (c) => `/messages/${c.bots[0].id}/${c.bots[1].id}`,
    onRetry: vi.fn(),
    pageCount: 1,
    lastPageStart: 0,
    hasMore: true,
    onLoadMore: vi.fn(),
    loadMore: "idle",
    now,
  };
  const { rerender } = render(<ConversationsView {...props} />);
  return { rerender, props };
}

const rows = () => screen.getAllByRole("listitem");
/** The element carrying `data-{name}` inside `scope`; throws when there is none. */
function part(scope: Element, name: string): HTMLElement {
  const el = scope.querySelector<HTMLElement>(`[data-${name}]`);
  if (!el) throw new Error(`no [data-${name}]`);
  return el;
}

describe("conversations list", () => {
  test("a row names both bots, the last message with its sender, the count and the time", () => {
    renderList({
      conversations: [conversation({ bots: [beta, gamma], count: 12 })],
    });
    const [row] = rows();
    if (!row) throw new Error("no row");
    const inRow = within(row);
    expect(inRow.getByText("Beta")).toBeInTheDocument();
    expect(inRow.getByText("Gamma")).toBeInTheDocument();
    expect(inRow.getByText("Release engineer")).toBeInTheDocument();
    expect(inRow.getAllByText("Bot")).toHaveLength(2);
    expect(part(row, "last-message")).toHaveTextContent(
      /^Beta: Deploy finished\. The volume backup runs nightly now\.$/,
    );
    expect(inRow.getByText("12 messages")).toBeInTheDocument();
    expect(inRow.getByText("13m")).toBeInTheDocument();
  });

  test("the last message names whichever bot sent it", () => {
    renderList({
      conversations: [
        conversation({
          lastMessage: { ...conversation().lastMessage, senderId: alpha.id },
        }),
      ],
    });
    expect(part(document.body, "last-message")).toHaveTextContent(/^Alpha: /);
  });

  test("a cut preview ends in an ellipsis; one message reads as one", () => {
    renderList({
      conversations: [
        conversation({
          count: 1,
          lastMessage: {
            ...conversation().lastMessage,
            preview: "The first part",
            truncated: true,
          },
        }),
      ],
    });
    expect(part(document.body, "last-message")).toHaveTextContent(
      /^Beta: The first part…$/,
    );
    expect(screen.getByText("1 message")).toBeInTheDocument();
  });

  test("each row links to its pair's page, named for the pair", () => {
    renderList({
      conversations: [conversation(), conversation({ bots: [beta, gamma] })],
    });
    expect(
      screen.getByRole("link", { name: "Alpha and Beta" }),
    ).toHaveAttribute("href", "/messages/a-alpha/a-beta");
    expect(
      screen.getByRole("link", { name: "Beta and Gamma" }),
    ).toHaveAttribute("href", "/messages/a-beta/a-gamma");
  });

  test("rows keep the order given: newest first", () => {
    renderList({
      conversations: [conversation({ bots: [beta, gamma] }), conversation()],
    });
    expect(
      screen.getAllByRole("link").map((a) => a.getAttribute("aria-label")),
    ).toEqual(["Beta and Gamma", "Alpha and Beta"]);
  });

  test("empty says bots write here and people only read", () => {
    renderList({ conversations: [] });
    expect(
      screen.getByRole("heading", { name: "No messages yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "When bots message each other, their conversations show up here. You can read them here, but not reply.",
      ),
    ).toBeInTheDocument();
  });

  test("loading is announced and shows no rows", () => {
    renderList({ status: "loading" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  test("a failed load offers Try again", async () => {
    const user = userEvent.setup();
    const props = renderList({ status: "error" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load messages",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  test("Load more shows while there is a next page and asks for it", async () => {
    const user = userEvent.setup();
    const props = renderList({ hasMore: true });
    await user.click(
      screen.getByRole("button", { name: "Load older conversations" }),
    );
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  });

  test("no Load more on the last page", () => {
    renderList({ hasMore: false });
    expect(
      screen.queryByRole("button", { name: "Load older conversations" }),
    ).not.toBeInTheDocument();
  });
});

describe("load more", () => {
  test("while a page loads the button is busy and a second press asks nothing", async () => {
    const user = userEvent.setup();
    const props = renderList({ hasMore: true, loadMore: "pending" });
    const button = screen.getByRole("button", { name: "Loading…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    expect(props.onLoadMore).not.toHaveBeenCalled();
  });

  test("a failed page says so and the button tries again", async () => {
    const user = userEvent.setup();
    const props = renderThread({ hasMore: true, loadMore: "error" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load more. Check your connection, then try again.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  });

  test("the first row of a new page takes focus after Load more", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderPagedList();
    await user.click(
      screen.getByRole("button", { name: "Load older conversations" }),
    );
    rerender(<ConversationsView {...props} loadMore="pending" />);
    rerender(
      <ConversationsView
        {...props}
        conversations={[first, older]}
        pageCount={2}
        lastPageStart={1}
        hasMore={false}
      />,
    );
    expect(screen.getByRole("link", { name: "Beta and Gamma" })).toHaveFocus();
  });

  test("a row a refetch adds at the top doesn't take focus from Load more", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderPagedList();
    const button = screen.getByRole("button", {
      name: "Load older conversations",
    });
    await user.click(button);
    rerender(<ConversationsView {...props} conversations={[fresh, first]} />);
    expect(document.body.querySelector(":focus")).toBe(button);
    rerender(
      <ConversationsView
        {...props}
        conversations={[fresh, first, older]}
        pageCount={2}
        lastPageStart={2}
        hasMore={false}
      />,
    );
    expect(screen.getByRole("link", { name: "Beta and Gamma" })).toHaveFocus();
  });

  test("after a failed page, a later page arriving by refetch takes no focus", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderPagedList();
    await user.click(
      screen.getByRole("button", { name: "Load older conversations" }),
    );
    rerender(<ConversationsView {...props} loadMore="error" />);
    const retry = screen.getByRole("button", { name: "Try again" });
    retry.blur();
    rerender(
      <ConversationsView
        {...props}
        conversations={[first, older]}
        pageCount={2}
        lastPageStart={1}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Beta and Gamma" }),
    ).not.toHaveFocus();
  });
});

describe("conversation thread", () => {
  test("a message shows its sender, title pill, Bot badge, time and markdown", () => {
    renderThread({
      messages: [message({ sender: gamma, recipient: beta })],
    });
    const item = within(rows()[0] as HTMLElement);
    expect(item.getByText("Gamma")).toBeInTheDocument();
    expect(item.getByText("Release engineer")).toBeInTheDocument();
    expect(item.getByText("Bot")).toBeInTheDocument();
    expect(item.getByText("status").tagName).toBe("STRONG");
    // one time in the header at 1440, one under the text below; CSS shows one
    expect(
      item.getAllByRole("time").map((t) => t.getAttribute("dateTime")),
    ).toEqual(["2026-11-11T09:12:00.000Z", "2026-11-11T09:12:00.000Z"]);
  });

  test("the header names both bots", () => {
    renderThread();
    expect(
      screen.getByRole("heading", { level: 1, name: "Alpha and Beta" }),
    ).toBeInTheDocument();
  });

  test("the header names the pair as given, whichever bot wrote first", () => {
    renderThread({
      messages: [message({ sender: beta, recipient: alpha })],
    });
    expect(
      screen.getByRole("heading", { level: 1, name: "Alpha and Beta" }),
    ).toBeInTheDocument();
    const header = screen.getByRole("banner");
    expect(
      within(header)
        .getAllByText(/^(Alpha|Beta)$/)
        .map((el) => el.textContent),
    ).toEqual(["Alpha", "Beta"]);
  });

  test("messages keep the order given: oldest first", () => {
    renderThread({
      messages: [
        message({ id: "m-1", text: "first" }),
        message({ id: "m-2", sender: beta, recipient: alpha, text: "second" }),
      ],
    });
    expect(rows().map((li) => li.textContent)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);
  });

  test("a reply quotes the message it answers, with that sender's name", () => {
    renderThread({
      messages: [
        message({
          id: "m-2",
          sender: beta,
          recipient: alpha,
          threadId: "m-1",
          replyTo: {
            id: "m-1",
            senderName: "Alpha",
            preview: "What's the status of the deploy?",
            truncated: true,
          },
          text: "Done.",
        }),
      ],
    });
    expect(part(document.body, "reply-quote")).toHaveTextContent(
      /^Replying to Alpha: What's the status of the deploy\?…$/,
    );
  });

  test("a thread's first message has no quote", () => {
    renderThread();
    expect(document.querySelector("[data-reply-quote]")).toBeNull();
  });

  test("the no-reply marker shows only on a message whose sender asked for none", () => {
    renderThread({
      messages: [
        message({ id: "m-1", text: "asks" }),
        message({ id: "m-2", text: "tells", expectsReply: false }),
      ],
    });
    const [asks, tells] = rows() as [HTMLElement, HTMLElement];
    expect(within(tells).getByText("Asked for no reply")).toBeInTheDocument();
    expect(
      within(asks).queryByText("Asked for no reply"),
    ).not.toBeInTheDocument();
  });

  test("the thread is read-only: no field and no button to send", () => {
    renderThread({
      messages: [message(), message({ id: "m-2", expectsReply: false })],
    });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(document.querySelector("form, input, textarea")).toBeNull();
  });

  test("Load newer messages asks for the next page", async () => {
    const user = userEvent.setup();
    const props = renderThread({ hasMore: true });
    await user.click(
      screen.getByRole("button", { name: "Load newer messages" }),
    );
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  });

  test("the first newly loaded message takes focus after Load newer messages", async () => {
    const user = userEvent.setup();
    const props: ConversationViewProps = {
      status: "ready",
      messages: [message()],
      bots: [alpha, beta],
      onRetry: vi.fn(),
      pageCount: 1,
      lastPageStart: 0,
      hasMore: true,
      onLoadMore: vi.fn(),
      loadMore: "idle",
    };
    const { rerender } = render(<ConversationView {...props} />);
    await user.click(
      screen.getByRole("button", { name: "Load newer messages" }),
    );
    rerender(
      <ConversationView
        {...props}
        messages={[
          message(),
          message({ id: "m-2", sender: beta, recipient: alpha, text: "newer" }),
        ]}
        pageCount={2}
        lastPageStart={1}
        hasMore={false}
      />,
    );
    const newer = rows()[1] as HTMLElement;
    expect(newer).toHaveTextContent("newer");
    expect(newer).toHaveFocus();
    expect(newer).toHaveClass("focus-visible:ring-3");
  });

  // gamma's id sorts after beta's, so a component that re-sorted by id would say "Beta and Gamma"
  test.each<[string, Partial<ConversationViewProps>]>([
    ["ready", {}],
    ["empty", { messages: [] }],
  ])(
    "a %s thread names its bots in the h1 in the order given",
    (_, overrides) => {
      renderThread({ ...overrides, bots: [gamma, beta] });
      expect(
        screen.getByRole("heading", { level: 1, name: "Gamma and Beta" }),
      ).toBeInTheDocument();
      expect(document.querySelector("[data-title-skeleton]")).toBeNull();
    },
  );

  test("loading holds the header's place with a skeleton under an sr-only Messages h1", () => {
    renderThread(loading);
    expect(
      screen.getByRole("heading", { level: 1, name: "Messages" }),
    ).toHaveClass("sr-only");
    expect(document.querySelector("[data-title-skeleton]")).not.toBeNull();
  });

  // jsdom lays nothing out, so the box is pinned by what sizes it: the header's own
  // classes, a title line at the h1's type, and a row of the chips' avatar size
  test("the loading header is built to the loaded header's height", () => {
    renderThread();
    const loaded = screen.getByRole("banner");
    const h1 = within(loaded).getByRole("heading", { level: 1 });
    const chips = h1.nextElementSibling as HTMLElement;
    const loadedBox = {
      header: loaded.className,
      title: h1.className,
      chips: chips.className,
    };
    cleanup();
    renderThread(loading);
    const skeleton = part(document.body, "title-skeleton");
    const [titleLine, chipRow] = Array.from(skeleton.children).filter(
      (el) => !el.classList.contains("sr-only"),
    ) as [HTMLElement, HTMLElement];
    expect(skeleton.className).toBe(loadedBox.header);
    for (const cls of loadedBox.title
      .split(" ")
      .filter((c) => c !== "font-semibold"))
      expect(titleLine).toHaveClass(cls);
    expect(titleLine).toHaveClass("h-lh");
    expect(chipRow.className).toBe(loadedBox.chips);
    expect(chipRow.querySelectorAll(".size-6")).toHaveLength(2);
  });

  test("empty names the two bots", () => {
    renderThread({ messages: [] });
    expect(
      screen.getByRole("heading", { name: "No messages yet" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Messages between/)).toHaveTextContent(
      "Messages between Alpha and Beta show up here.",
    );
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  test("loading is announced and shows no messages", () => {
    renderThread(loading);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  test("a failed first load titles the page Conversation over the error, and offers Try again", async () => {
    const user = userEvent.setup();
    const props = renderThread(failed);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent(/^Conversation$/);
    expect(h1).not.toHaveClass("sr-only");
    expect(screen.queryByText("Bot")).not.toBeInTheDocument();
    expect(document.querySelector("[data-title-skeleton]")).toBeNull();
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load this conversation",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  test("a failed load with its bots known keeps the sr-only Messages h1", () => {
    renderThread({ ...failed, bots: [alpha, beta] });
    expect(
      screen.getByRole("heading", { level: 1, name: "Messages" }),
    ).toHaveClass("sr-only");
  });

  test("a pair that isn't two bots reads as Page not found", () => {
    renderThread({ status: "not_found" });
    expect(
      screen.getByRole("heading", { name: "Page not found" }),
    ).toBeInTheDocument();
  });
});

describe("conversation breadcrumb", () => {
  test("links back to the list and names the pair once loaded", () => {
    render(
      <ConversationBreadcrumb listHref="/messages" bots={[alpha, beta]} />,
    );
    expect(screen.getByRole("link", { name: "Messages" })).toHaveAttribute(
      "href",
      "/messages",
    );
    expect(screen.getByText("Alpha and Beta")).toBeInTheDocument();
  });

  test("names the pair in the list's order, whichever order it's handed", () => {
    render(
      <ConversationBreadcrumb listHref="/messages" bots={[beta, alpha]} />,
    );
    expect(screen.getByText("Alpha and Beta")).toBeInTheDocument();
  });

  test("before the pair is known, Messages shows at every width", () => {
    render(<ConversationBreadcrumb listHref="/messages" />);
    const link = screen.getByRole("link", { name: "Messages" });
    expect(link.parentElement).not.toHaveClass("max-lg:hidden");
  });

  test("once the pair is known, Messages hides below the desktop layout", () => {
    render(
      <ConversationBreadcrumb listHref="/messages" bots={[alpha, beta]} />,
    );
    const link = screen.getByRole("link", { name: "Messages" });
    expect(link.parentElement).toHaveClass("max-lg:hidden");
  });
});
