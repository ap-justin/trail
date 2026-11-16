import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import {
  ConversationBreadcrumb,
  ConversationsView,
  type ConversationsViewProps,
  ConversationView,
  type ConversationViewProps,
} from "@/components/messages";
import type { WebActorView } from "@/lib/api-types";
import { alpha, beta, conversation, message } from "@/test/fixtures";

const now = new Date("2026-11-11T09:53:00.000Z");

const gamma: WebActorView = {
  id: "a-gamma",
  name: "Gamma",
  kind: "bot",
  photoUrl: null,
  title: "Release captain",
};

function renderList(overrides: Partial<ConversationsViewProps> = {}) {
  const props: ConversationsViewProps = {
    status: "ready",
    conversations: [conversation()],
    conversationHref: (c) => `/messages/${c.bots[0].id}/${c.bots[1].id}`,
    onRetry: vi.fn(),
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
    onRetry: vi.fn(),
    hasMore: false,
    onLoadMore: vi.fn(),
    loadMore: "idle",
    ...overrides,
  };
  render(<ConversationView {...props} />);
  return props;
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
    expect(inRow.getByText("Release captain")).toBeInTheDocument();
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
        "When bots message each other, their conversations show up here. People can read them, not send.",
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
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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
    const first = conversation();
    const onLoadMore = vi.fn();
    const props: ConversationsViewProps = {
      status: "ready",
      conversations: [first],
      conversationHref: () => "/messages/x/y",
      onRetry: vi.fn(),
      hasMore: true,
      onLoadMore,
      loadMore: "idle",
      now,
    };
    const { rerender } = render(<ConversationsView {...props} />);
    await user.click(
      screen.getByRole("button", { name: "Load older conversations" }),
    );
    const older = conversation({ bots: [beta, gamma] });
    rerender(
      <ConversationsView
        {...props}
        conversations={[first, older]}
        hasMore={false}
      />,
    );
    expect(screen.getByRole("link", { name: "Beta and Gamma" })).toHaveFocus();
  });
});

describe("conversation thread", () => {
  test("a message shows its sender, title pill, Bot badge, time and markdown", () => {
    renderThread({
      messages: [message({ sender: gamma, recipient: beta })],
    });
    const item = within(rows()[0] as HTMLElement);
    expect(item.getByText("Gamma")).toBeInTheDocument();
    expect(item.getByText("Release captain")).toBeInTheDocument();
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

  test("empty says messages between these bots show up here", () => {
    renderThread({ messages: [] });
    expect(
      screen.getByRole("heading", { name: "No messages yet" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  test("loading is announced and shows no messages", () => {
    renderThread({ status: "loading" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  test("a failed load offers Try again", async () => {
    const user = userEvent.setup();
    const props = renderThread({ status: "error" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load this conversation",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
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
});
