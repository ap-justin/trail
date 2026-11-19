import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { BotTitle } from "@/components/actor";
import { FeedView, type FeedViewProps } from "@/components/feed";
import { IssueView } from "@/components/issue";
import { ProductView } from "@/components/product";
import { ProductsView } from "@/components/products";
import type { WebActorView } from "@/lib/api-types";
import {
  alpha,
  beta,
  commentEntry,
  issue,
  issueList,
  issueRow,
  maya,
  product,
  statusUpdate,
  trail,
} from "@/test/fixtures";

const alphaTitled: WebActorView = { ...alpha, title: "Platform Engineer" };
const betaTitled: WebActorView = { ...beta, title: "Release manager" };
const now = new Date("2026-11-11T12:00:00.000Z");

const titlesIn = (scope: HTMLElement, title: string) =>
  within(scope).queryAllByTitle(title);

/** A title is plain grey text: no fill, no edge, no pill. */
function expectPlainTitle(title: HTMLElement) {
  expect(title).toHaveClass("truncate", "text-muted-foreground");
  expect(title.className).not.toMatch(/\b(?:bg-|border|rounded)/);
}

/** Name, then its plain title, in document order and one group within `scope`. */
function expectNameThenTitle(scope: HTMLElement, name: string, title: string) {
  const inScope = within(scope);
  const nameEl = inScope.getByText(name);
  const titleEl = inScope.getByTitle(title);
  expect(
    nameEl.compareDocumentPosition(titleEl) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // one group, so they wrap together
  expect(titleEl.parentElement).toBe(nameEl.parentElement);
  expectPlainTitle(titleEl);
}

function renderFeed(overrides: Partial<FeedViewProps> = {}) {
  render(
    <FeedView
      status="ready"
      entries={[
        commentEntry("e1", "2026-11-11T11:59:00.000Z", { actor: alphaTitled }),
        commentEntry("e2", "2026-11-11T11:50:00.000Z", { actor: maya }),
      ]}
      freshIds={new Set()}
      connection="open"
      pendingCount={0}
      onShowPending={vi.fn()}
      onAtTopChange={vi.fn()}
      filters={{ actors: [alphaTitled, beta], products: [trail], projects: [] }}
      actorFilter={null}
      productFilter={null}
      projectFilter={null}
      typeFilter={null}
      onActorFilterChange={vi.fn()}
      onProductFilterChange={vi.fn()}
      onProjectFilterChange={vi.fn()}
      onTypeFilterChange={vi.fn()}
      onRetry={vi.fn()}
      now={now}
      {...overrides}
    />,
  );
}

const rowFor = (id: string) => {
  const row = document.querySelector<HTMLElement>(`[data-entry-id="${id}"]`);
  if (!row) throw new Error(`no row ${id}`);
  return row;
};

describe("BotTitle", () => {
  test("shows a bot's title as plain grey text that truncates, the whole title in its tooltip", () => {
    render(<BotTitle actor={alphaTitled} />);
    const title = screen.getByTitle("Platform Engineer");
    expect(title).toHaveTextContent("Platform Engineer");
    expectPlainTitle(title);
  });

  test("renders nothing for a bot without a title, an empty one, or a person", () => {
    const { container } = render(
      <>
        <BotTitle actor={alpha} />
        <BotTitle actor={{ ...alpha, title: "" }} />
        {/* never for a person, whatever the data says */}
        <BotTitle actor={{ ...maya, title: "Owner" }} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("feed", () => {
  test("a bot's row reads name then title, with no Bot or Human word; a person's row has no title", () => {
    renderFeed();
    const row = rowFor("e1");
    expect(titlesIn(row, "Platform Engineer")).toHaveLength(1);
    expectNameThenTitle(row, "Alpha", "Platform Engineer");
    expect(rowFor("e2").querySelector("[title]:not(time)")).toBeNull();
    for (const id of ["e1", "e2"]) {
      expect(within(rowFor(id)).queryByText(/^(?:Bot|Human)$/)).toBeNull();
    }
  });

  test("the bot filter menu shows each bot's title; the trigger shows the name alone", async () => {
    const user = userEvent.setup();
    renderFeed({ actorFilter: alphaTitled.id });
    const trigger = screen.getByRole("combobox", { name: "Filter by bot" });
    expect(trigger).toHaveTextContent("Alpha");
    expect(trigger).not.toHaveTextContent("Platform Engineer");
    expect(titlesIn(trigger, "Platform Engineer")).toHaveLength(0);
    await user.click(trigger);
    const alphaOption = await screen.findByRole("option", { name: /Alpha/ });
    expect(titlesIn(alphaOption, "Platform Engineer")).toHaveLength(1);
    const betaOption = screen.getByRole("option", { name: "Beta" });
    expect(betaOption.querySelector("[title]")).toBeNull();
  });

  test("in the filter menu the title's own shrink is replaced, so a long name truncates beside a whole title", async () => {
    const user = userEvent.setup();
    renderFeed();
    await user.click(screen.getByRole("combobox", { name: "Filter by bot" }));
    const alphaOption = await screen.findByRole("option", { name: /Alpha/ });
    const [title] = titlesIn(alphaOption, "Platform Engineer");
    // BotTitle shrinks by default (shrink-4); the menu's className must win the merge
    expect(title).toHaveClass("shrink-0");
    expect(title).not.toHaveClass("shrink-4");
  });
});

describe("issue", () => {
  function renderIssue(assignee: WebActorView = alphaTitled) {
    const on = {
      product: trail,
      project: null,
      item: { key: "TRL-14", title: "Team access", type: "issue" as const },
    };
    render(
      <IssueView
        issueKey="TRL-14"
        issue={{
          status: "ready",
          data: issue({
            creator: betaTitled,
            assignee,
            timeline: [
              {
                ...on,
                kind: "priority_changed",
                id: "t1",
                createdAt: "2026-11-09T14:05:00.000Z",
                actor: alphaTitled,
                from: 0,
                to: 2,
              },
              {
                ...on,
                kind: "comment",
                id: "t2",
                createdAt: "2026-11-10T17:12:00.000Z",
                actor: alphaTitled,
                comment: { id: "c1", body: "Looks right.", sourceAuthor: null },
              },
              {
                ...on,
                kind: "comment",
                id: "t3",
                createdAt: "2026-11-10T18:00:00.000Z",
                actor: maya,
                comment: { id: "c2", body: "Agreed.", sourceAuthor: null },
              },
            ],
          }),
        }}
        viewer={{ name: "Maya Chen" }}
        onRetry={vi.fn()}
        onComment={vi.fn()}
        commentPending={false}
        commentError={null}
      />,
    );
  }

  test("the creator line carries the creator's title after the name", () => {
    renderIssue();
    const byLine = screen.getByRole("banner");
    expect(titlesIn(byLine, "Release manager")).toHaveLength(1);
    expectNameThenTitle(byLine, "Beta", "Release manager");
  });

  test("the Assignee property carries the assignee's title", () => {
    renderIssue();
    const assignee = screen.getByText("Assignee").nextElementSibling;
    if (!(assignee instanceof HTMLElement))
      throw new Error("no assignee value");
    expect(titlesIn(assignee, "Platform Engineer")).toHaveLength(1);
    expectNameThenTitle(assignee, "Alpha", "Platform Engineer");
  });

  test.each([
    ["with a title", "Platform Engineer"],
    ["without one", null],
  ])(
    "a long assignee name, %s, keeps its bot avatar, and its title only when it has one",
    (_, title) => {
      const name = "release-coordinator-staging-east";
      renderIssue({ ...alpha, name, title });
      const assignee = screen.getByText("Assignee").nextElementSibling;
      if (!(assignee instanceof HTMLElement))
        throw new Error("no assignee value");
      const nameEl = within(assignee).getByText(name);
      expect(nameEl).toBeInTheDocument();
      if (title) {
        expect(within(assignee).getByTitle(title)).toBeInTheDocument();
      } else {
        expect(assignee.querySelector("[title]")).toBeNull();
      }
      expect(
        within(assignee).getByRole("img", { name: `${name}, bot` }),
      ).toBeInTheDocument();
    },
  );

  test("activity lines and comment headers carry it as plain text", () => {
    renderIssue();
    for (const id of ["t1", "t2"]) {
      const titles = titlesIn(rowFor(id), "Platform Engineer");
      expect(titles).toHaveLength(1);
      expectPlainTitle(titles[0] as HTMLElement);
    }
    expect(rowFor("t3").querySelector("[title]")).toBeNull();
  });
});

describe("products", () => {
  test("the latest update's author line carries the title, in the table and on the card", () => {
    render(
      <ProductsView
        status="ready"
        products={[
          product({ latestStatusUpdate: statusUpdate({ author: betaTitled }) }),
        ]}
        ownerName="Jordan Smith"
        isOwner={false}
        onRetry={vi.fn()}
        now={now}
      />,
    );
    const table = screen.getByRole("table");
    expect(titlesIn(table, "Release manager")).toHaveLength(1);
    expectNameThenTitle(table, "Beta", "Release manager");
    expect(
      titlesIn(screen.getByRole("listitem"), "Release manager"),
    ).toHaveLength(1);
  });
});

describe("product", () => {
  function renderProduct() {
    render(
      <ProductView
        product={trail}
        detail={null}
        items={{
          status: "ready",
          data: issueList([issueRow({ assignee: betaTitled })]),
        }}
        counts={null}
        statusUpdates={{
          status: "ready",
          data: {
            items: [
              statusUpdate({ author: betaTitled }),
              statusUpdate({ id: "su-2", author: beta }),
            ],
            nextCursor: null,
          },
        }}
        filters={{ type: null, status: null }}
        onFiltersChange={vi.fn()}
        notes={{ status: "ready", data: [] }}
        noteCounts={null}
        onRetryItems={vi.fn()}
        onRetryNotes={vi.fn()}
        onRetryStatusUpdates={vi.fn()}
        onNewIssue={vi.fn()}
        now={now}
      />,
    );
  }

  test("a status update reads avatar, name and title on one line, then health and date; the issue list's assignee never carries it", () => {
    renderProduct();
    // the issue table (1440), its rows (375) and both updates are all in the DOM
    const pills = screen.getAllByTitle("Release manager");
    expect(pills).toHaveLength(1);
    const pill = pills[0] as HTMLElement;
    const update = pill.closest("li");
    if (!update) throw new Error("no status update");
    const name = within(update).getByText("Beta");
    const health = within(update).getByText("On track");
    // line 1: avatar, then name and title together; the name truncates rather than pushing the row wider
    expect(name.parentElement).toBe(pill.parentElement);
    expect(
      within(update).getByRole("img", { name: "Beta, bot" }).nextElementSibling,
    ).toBe(name.parentElement);
    expect(within(update).queryByText("Bot")).toBeNull();
    expect(name).toHaveClass("max-w-full", "shrink-0", "truncate");
    // line 2 below lg: health, then the date; at lg the health ends line 1
    expect(health.nextElementSibling?.tagName).toBe("TIME");
    expect(health.parentElement?.previousElementSibling).toBe(
      name.parentElement,
    );
    expect(health).toHaveClass("lg:col-start-3", "lg:row-start-1");
    expect(titlesIn(screen.getByRole("table"), "Release manager")).toHaveLength(
      0,
    );
  });
});
