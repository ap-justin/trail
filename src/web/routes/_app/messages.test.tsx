import { focusManager } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, test, vi } from "vitest";
import type {
  WebConversationPageView,
  WebMessagePageView,
} from "@/lib/api-types";
import { createQueryClient, MESSAGES_STALE_MS } from "@/lib/queries";
import { notFound, renderApp, serveFeed, signedInAs } from "@/test/app";
import { alpha, beta, conversation, gamma, message } from "@/test/fixtures";
import { server } from "@/test/server";

/** Answers the conversation list with `pages` in turn by cursor, recording each request's query. */
function serveConversations(pages: WebConversationPageView[]) {
  const asked: URLSearchParams[] = [];
  server.use(
    http.get("/api/web/messages", ({ request }) => {
      const query = new URL(request.url).searchParams;
      asked.push(query);
      const index = Number(query.get("cursor") ?? "0");
      return HttpResponse.json(pages[index]);
    }),
  );
  return asked;
}

/** Answers every pair's messages with `pages` in turn by cursor, recording each request's path and query. */
function serveConversation(pages: WebMessagePageView[]) {
  const asked: URL[] = [];
  server.use(
    http.get("/api/web/messages/:a/:b", ({ request }) => {
      const url = new URL(request.url);
      asked.push(url);
      return HttpResponse.json(
        pages[Number(url.searchParams.get("cursor") ?? "0")],
      );
    }),
  );
  return asked;
}

function refocusWindow() {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

/** Long enough for a focus refetch, had one started, to have sent its first request. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const reply = message({
  id: "m-2",
  sender: beta,
  recipient: message().sender,
  replyTo: {
    id: "m-1",
    senderName: "Alpha",
    preview: "What's the status of the deploy?",
    truncated: false,
  },
  text: "Deploy is **running**.",
  createdAt: "2026-11-11T09:20:00.000Z",
});

describe("owner only", () => {
  test("a member has no Messages nav item", async () => {
    signedInAs("member");
    serveFeed();
    renderApp("/");
    await screen.findByText("No activity yet");
    expect(
      screen.queryByRole("link", { name: "Messages" }),
    ).not.toBeInTheDocument();
  });

  test("a member opening the list sees Not found, and the list is never read", async () => {
    signedInAs("member");
    const asked = serveConversations([
      { items: [conversation()], nextCursor: null },
    ]);
    renderApp("/messages");
    expect(
      await screen.findByRole("heading", { name: "Page not found", level: 1 }),
    ).toBeInTheDocument();
    expect(asked).toHaveLength(0);
  });

  test("a member opening a pair sees Not found, and its messages are never read", async () => {
    signedInAs("member");
    const asked = serveConversation([
      { bots: [alpha, beta], items: [message()], nextCursor: null },
    ]);
    renderApp("/messages/a-alpha/a-beta");
    expect(
      await screen.findByRole("heading", { name: "Page not found", level: 1 }),
    ).toBeInTheDocument();
    expect(asked).toHaveLength(0);
  });

  test("the owner opening a pair reads its messages", async () => {
    signedInAs("owner");
    const asked = serveConversation([
      { bots: [alpha, beta], items: [message(), reply], nextCursor: null },
    ]);
    renderApp("/messages/a-alpha/a-beta");
    expect(
      await screen.findByRole("heading", { name: "Alpha and Beta", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(asked.map((url) => url.pathname)).toEqual([
      "/api/web/messages/a-alpha/a-beta",
    ]);
  });

  test("a pair the server doesn't know is Not found", async () => {
    signedInAs("owner");
    server.use(http.get("/api/web/messages/:a/:b", notFound));
    renderApp("/messages/a-alpha/a-nobody");
    expect(
      await screen.findByRole("heading", { name: "Page not found", level: 1 }),
    ).toBeInTheDocument();
  });
});

describe("the conversation list", () => {
  test("the owner has the Messages nav item and the list", async () => {
    signedInAs("owner");
    serveConversations([{ items: [conversation()], nextCursor: null }]);
    renderApp("/messages");
    expect(
      await screen.findByRole("link", { name: "Alpha and Beta" }),
    ).toBeInTheDocument();
    const sidebar = screen.getAllByRole("navigation", { name: "Main" })[0];
    if (!sidebar) throw new Error("no main nav");
    expect(
      within(sidebar).getByRole("link", { name: "Messages" }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("Load older conversations appends the next page under the first", async () => {
    signedInAs("owner");
    const asked = serveConversations([
      { items: [conversation()], nextCursor: "1" },
      { items: [conversation({ bots: [alpha, gamma] })], nextCursor: null },
    ]);
    renderApp("/messages");
    await screen.findByRole("link", { name: "Alpha and Beta" });
    await userEvent.click(
      screen.getByRole("button", { name: "Load older conversations" }),
    );
    expect(
      await screen.findByRole("link", { name: "Alpha and Gamma" }),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("link", { name: /^Alpha and / })
        .map((a) => a.textContent),
    ).toEqual([
      expect.stringContaining("Beta"),
      expect.stringContaining("Gamma"),
    ]);
    expect(asked.map((query) => query.get("cursor"))).toEqual([null, "1"]);
    expect(
      screen.queryByRole("button", { name: "Load older conversations" }),
    ).not.toBeInTheDocument();
  });

  test("coming back to the window soon after doesn't re-read the list", async () => {
    signedInAs("owner");
    const asked = serveConversations([
      { items: [conversation()], nextCursor: null },
    ]);
    renderApp("/messages");
    await screen.findByRole("link", { name: "Alpha and Beta" });
    refocusWindow();
    await settle();
    expect(asked).toHaveLength(1);
  });

  test("a row opens its pair's conversation", async () => {
    signedInAs("owner");
    serveConversations([{ items: [conversation()], nextCursor: null }]);
    serveConversation([
      { bots: [alpha, beta], items: [message(), reply], nextCursor: null },
    ]);
    renderApp("/messages");
    const row = await screen.findByRole("link", { name: "Alpha and Beta" });
    expect(row).toHaveAttribute("href", "/messages/a-alpha/a-beta");
    await userEvent.click(row);
    expect(
      await screen.findByRole("heading", { name: "Alpha and Beta", level: 1 }),
    ).toBeInTheDocument();
  });
});

describe("a conversation", () => {
  test("Load newer messages appends the next page after the first", async () => {
    signedInAs("owner");
    const asked = serveConversation([
      { bots: [alpha, beta], items: [message()], nextCursor: "1" },
      { bots: [alpha, beta], items: [reply], nextCursor: null },
    ]);
    renderApp("/messages/a-alpha/a-beta");
    const list = await screen.findByRole("list", { name: "Messages" });
    await userEvent.click(
      screen.getByRole("button", { name: "Load newer messages" }),
    );
    expect(await within(list).findByText("running")).toBeInTheDocument();
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(asked.map((url) => url.searchParams.get("cursor"))).toEqual([
      null,
      "1",
    ]);
  });

  test("a pair named in either order is one conversation, read once", async () => {
    signedInAs("owner");
    const asked = serveConversation([
      { bots: [alpha, beta], items: [message()], nextCursor: null },
    ]);
    serveConversations([{ items: [conversation()], nextCursor: null }]);
    const { router } = renderApp("/messages/a-alpha/a-beta");
    await screen.findByRole("list", { name: "Messages" });
    await act(() => router.navigate({ to: "/messages" }));
    await screen.findByRole("link", { name: "Alpha and Beta" });

    await act(() =>
      router.navigate({
        to: "/messages/$a/$b",
        params: { a: "a-beta", b: "a-alpha" },
      }),
    );
    await screen.findByRole("list", { name: "Messages" });
    expect(router.state.location.pathname).toBe("/messages/a-alpha/a-beta");
    expect(asked.map((url) => url.pathname)).toEqual([
      "/api/web/messages/a-alpha/a-beta",
    ]);

    // the reversed URL never entered history, so Back leaves the pair instead of bouncing off it
    await act(async () => router.history.back());
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/messages"),
    );
  });

  test("coming back to the window re-reads the loaded pages only once they've gone stale", async () => {
    signedInAs("owner");
    const asked = serveConversation([
      { bots: [alpha, beta], items: [message()], nextCursor: "1" },
      { bots: [alpha, beta], items: [reply], nextCursor: null },
    ]);
    renderApp("/messages/a-alpha/a-beta");
    const list = await screen.findByRole("list", { name: "Messages" });
    await userEvent.click(
      screen.getByRole("button", { name: "Load newer messages" }),
    );
    await within(list).findByText("running");

    refocusWindow();
    await settle();
    expect(asked).toHaveLength(2);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + MESSAGES_STALE_MS + 1);
      refocusWindow();
      await waitFor(() => expect(asked).toHaveLength(4));
    } finally {
      vi.useRealTimers();
    }
    expect(asked.map((url) => url.searchParams.get("cursor"))).toEqual([
      null,
      "1",
      null,
      "1",
    ]);
  });

  test("a pair with no messages yet is named in the heading, the breadcrumb and the empty state", async () => {
    signedInAs("owner");
    serveConversation([{ bots: [alpha, beta], items: [], nextCursor: null }]);
    renderApp("/messages/a-alpha/a-beta");
    expect(
      await screen.findByRole("heading", { name: "Alpha and Beta", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    expect(
      screen.getByText("Messages between Alpha and Beta show up here."),
    ).toBeInTheDocument();
    const [breadcrumb] = screen.getAllByRole("navigation", {
      name: "Breadcrumb",
    });
    expect(breadcrumb).toHaveTextContent("Messages/Alpha and Beta");
  });

  describe("on the app's own retry policy", () => {
    /** Counts every request for the pair's messages, answering each with `status`. */
    function failConversation(status: number) {
      const asked: URL[] = [];
      server.use(
        http.get("/api/web/messages/:a/:b", ({ request }) => {
          asked.push(new URL(request.url));
          return HttpResponse.json(
            { error: { code: "failed", message: "Failed." } },
            { status },
          );
        }),
      );
      return asked;
    }

    const renderRetrying = (path: string) =>
      renderApp(
        path,
        createQueryClient({ defaultOptions: { queries: { retryDelay: 0 } } }),
      );

    test("a 404 shows Not found after a single request", async () => {
      signedInAs("owner");
      const asked = failConversation(404);
      renderRetrying("/messages/a-alpha/a-nobody");
      expect(
        await screen.findByRole("heading", {
          name: "Page not found",
          level: 1,
        }),
      ).toBeInTheDocument();
      // the error renders only once the query has stopped retrying, so every request is counted
      expect(asked).toHaveLength(1);
    });

    test("a 403 shows the error after a single request", async () => {
      signedInAs("owner");
      const asked = failConversation(403);
      renderRetrying("/messages/a-alpha/a-beta");
      expect(
        await screen.findByText("Couldn't load this conversation"),
      ).toBeInTheDocument();
      // the error renders only once the query has stopped retrying, so every request is counted
      expect(asked).toHaveLength(1);
    });

    test("a 500 is retried before the error shows", async () => {
      signedInAs("owner");
      const asked = failConversation(500);
      renderRetrying("/messages/a-alpha/a-beta");
      expect(
        await screen.findByText("Couldn't load this conversation"),
      ).toBeInTheDocument();
      expect(asked).toHaveLength(3);
    });
  });

  test("the shell names the pair in a breadcrumb back to the list", async () => {
    signedInAs("owner");
    serveConversation([
      { bots: [alpha, beta], items: [message()], nextCursor: null },
    ]);
    renderApp("/messages/a-alpha/a-beta");
    await screen.findByRole("heading", { name: "Alpha and Beta", level: 1 });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const [breadcrumb] = screen.getAllByRole("navigation", {
      name: "Breadcrumb",
    });
    if (!breadcrumb) throw new Error("no breadcrumb");
    expect(breadcrumb).toHaveTextContent("Messages/Alpha and Beta");
    expect(
      within(breadcrumb).getByRole("link", { name: "Messages" }),
    ).toHaveAttribute("href", "/messages");
    expect(
      screen.getByRole("link", { name: "Back to Messages" }),
    ).toHaveAttribute("href", "/messages");
  });
});
