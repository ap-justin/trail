import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { FeedView, type FeedViewProps, LiveIndicator } from "@/components/feed";
import { commentEntry, kai, kaiWithPhoto, statusEntry } from "@/test/fixtures";

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
    filters: { actors: [kai], projects: [{ key: "TRL", name: "trail" }] },
    actorFilter: null,
    projectFilter: null,
    onActorFilterChange: vi.fn(),
    onProjectFilterChange: vi.fn(),
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

describe("actor photos", () => {
  test("an entry by an actor with a photo shows the photo; one without shows initials", () => {
    renderFeed({
      entries: [
        commentEntry("e1", minutesAgo(1), { actor: kaiWithPhoto }),
        statusEntry("e2", minutesAgo(30)),
      ],
    });
    expect(rowFor("e1").querySelector("img")).toHaveAttribute(
      "src",
      kaiWithPhoto.photoUrl,
    );
    expect(rowFor("e2").querySelector("img")).toBeNull();
    expect(within(rowFor("e2")).getByText("K")).toBeInTheDocument();
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
    ).toHaveAttribute("href", "/issues/TRL-14");
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
            sourceAuthor: "Justin Salas",
          },
        }),
      ],
    });
    const row = rowFor("e1");
    expect(within(row).getByText("Kai")).toBeInTheDocument();
    expect(
      within(row).getByText("originally by Justin Salas"),
    ).toBeInTheDocument();
  });
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
