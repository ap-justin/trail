import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { BotTitle } from "@/components/actor";
import { FeedView, type FeedViewProps } from "@/components/feed";
import { IssueView } from "@/components/issue";
import { ProjectView } from "@/components/project";
import { ProjectsView } from "@/components/projects";
import type { WebActorView } from "@/lib/api-types";
import {
  commentEntry,
  issue,
  issueList,
  issueRow,
  kai,
  maya,
  project,
  statusUpdate,
  tara,
  trail,
} from "@/test/fixtures";

const kaiTitled: WebActorView = { ...kai, title: "Platform Engineer" };
const taraTitled: WebActorView = { ...tara, title: "Release manager" };
const now = new Date("2026-11-11T12:00:00.000Z");

const pillsIn = (scope: HTMLElement, title: string) =>
  within(scope).queryAllByTitle(title);

/** Name, then title pill, then Bot badge, in document order and one group within `scope`. */
function expectNamePillBadge(scope: HTMLElement, name: string, title: string) {
  const inScope = within(scope);
  const [nameEl, pill, badge] = [
    inScope.getByText(name),
    inScope.getByTitle(title),
    inScope.getByText("Bot"),
  ];
  const follows = (a: Node, b: Node) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  expect(follows(nameEl, pill)).toBe(true);
  expect(follows(pill, badge)).toBe(true);
  // one group, so they wrap together
  const group = nameEl.parentElement;
  expect(pill.parentElement).toBe(group);
  expect(badge.parentElement).toBe(group);
}

function renderFeed(overrides: Partial<FeedViewProps> = {}) {
  render(
    <FeedView
      status="ready"
      entries={[
        commentEntry("e1", "2026-11-11T11:59:00.000Z", { actor: kaiTitled }),
        commentEntry("e2", "2026-11-11T11:50:00.000Z", { actor: maya }),
      ]}
      freshIds={new Set()}
      connection="open"
      pendingCount={0}
      onShowPending={vi.fn()}
      onAtTopChange={vi.fn()}
      filters={{ actors: [kaiTitled, tara], projects: [trail] }}
      actorFilter={null}
      projectFilter={null}
      onActorFilterChange={vi.fn()}
      onProjectFilterChange={vi.fn()}
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
  test("shows a bot's title in a pill, the whole title in its tooltip", () => {
    render(<BotTitle actor={kaiTitled} />);
    const pill = screen.getByTitle("Platform Engineer");
    expect(pill).toHaveTextContent("Platform Engineer");
    expect(pill).toHaveClass("bg-muted");
  });

  test("renders nothing for a bot without a title, an empty one, or a person", () => {
    const { container } = render(
      <>
        <BotTitle actor={kai} />
        <BotTitle actor={{ ...kai, title: "" }} />
        {/* never for a person, whatever the data says */}
        <BotTitle actor={{ ...maya, title: "Owner" }} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("feed", () => {
  test("a bot's row reads name, title pill, Bot badge; a person's row has no pill", () => {
    renderFeed();
    const row = rowFor("e1");
    expect(pillsIn(row, "Platform Engineer")).toHaveLength(1);
    expectNamePillBadge(row, "Kai", "Platform Engineer");
    expect(row.querySelector("[title]:not(time)")).not.toBeNull();
    expect(rowFor("e2").querySelector("[title]:not(time)")).toBeNull();
  });

  test("the bot filter menu shows each bot's title; the trigger shows the name alone", async () => {
    const user = userEvent.setup();
    renderFeed({ actorFilter: kaiTitled.id });
    const trigger = screen.getByRole("combobox", { name: "Filter by bot" });
    expect(trigger).toHaveTextContent("Kai");
    expect(trigger).not.toHaveTextContent("Platform Engineer");
    expect(pillsIn(trigger, "Platform Engineer")).toHaveLength(0);
    await user.click(trigger);
    const kaiOption = await screen.findByRole("option", { name: /Kai/ });
    expect(pillsIn(kaiOption, "Platform Engineer")).toHaveLength(1);
    const taraOption = screen.getByRole("option", { name: "Tara" });
    expect(taraOption.querySelector("[title]")).toBeNull();
  });

  test("in the filter menu the pill's own shrink is replaced, so a long name truncates beside a whole pill", async () => {
    const user = userEvent.setup();
    renderFeed();
    await user.click(screen.getByRole("combobox", { name: "Filter by bot" }));
    const kaiOption = await screen.findByRole("option", { name: /Kai/ });
    const [pill] = pillsIn(kaiOption, "Platform Engineer");
    // BotTitle shrinks by default (shrink-4); the menu's className must win the merge
    expect(pill).toHaveClass("shrink-0");
    expect(pill).not.toHaveClass("shrink-4");
  });

  test("a menu pill sits on the background, so it still shows on the highlighted row", async () => {
    const user = userEvent.setup();
    renderFeed();
    await user.click(screen.getByRole("combobox", { name: "Filter by bot" }));
    const kaiOption = await screen.findByRole("option", { name: /Kai/ });
    const [pill] = pillsIn(kaiOption, "Platform Engineer");
    // the highlight is bg-accent, the same fill as bg-muted in light theme
    expect(pill).toHaveClass("bg-background");
    expect(pill).not.toHaveClass("bg-muted");
  });
});

describe("issue", () => {
  function renderIssue(assignee: WebActorView = kaiTitled) {
    const on = {
      project: trail,
      issue: { key: "TRL-14", title: "Team access" },
    };
    render(
      <IssueView
        issueKey="TRL-14"
        issue={{
          status: "ready",
          data: issue({
            creator: taraTitled,
            assignee,
            timeline: [
              {
                ...on,
                kind: "priority_changed",
                id: "t1",
                createdAt: "2026-11-09T14:05:00.000Z",
                actor: kaiTitled,
                from: 0,
                to: 2,
              },
              {
                ...on,
                kind: "comment",
                id: "t2",
                createdAt: "2026-11-10T17:12:00.000Z",
                actor: kaiTitled,
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

  test("the creator line carries the creator's title between name and badge", () => {
    renderIssue();
    const byLine = screen.getByRole("banner");
    expect(pillsIn(byLine, "Release manager")).toHaveLength(1);
    expectNamePillBadge(byLine, "Tara", "Release manager");
  });

  test("the Assignee property carries the assignee's title", () => {
    renderIssue();
    const assignee = screen.getByText("Assignee").nextElementSibling;
    if (!(assignee instanceof HTMLElement))
      throw new Error("no assignee value");
    expect(pillsIn(assignee, "Platform Engineer")).toHaveLength(1);
    expectNamePillBadge(assignee, "Kai", "Platform Engineer");
  });

  test.each([
    ["with a title", "Platform Engineer"],
    ["without one", null],
  ])(
    "a long assignee name, %s, keeps its Bot badge, and its title only when it has one",
    (_, title) => {
      const name = "release-coordinator-staging-east";
      renderIssue({ ...kai, name, title });
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
      expect(within(assignee).getByText("Bot")).toBeInTheDocument();
    },
  );

  test("activity lines and comment headers carry it; a comment header's pill sits on the background", () => {
    renderIssue();
    const line = rowFor("t1");
    expect(pillsIn(line, "Platform Engineer")).toHaveLength(1);
    expect(pillsIn(line, "Platform Engineer")[0]).toHaveClass("bg-muted");
    const [commentPill] = pillsIn(rowFor("t2"), "Platform Engineer");
    expect(commentPill).toHaveClass("bg-background");
    expect(commentPill).not.toHaveClass("bg-muted");
    expect(rowFor("t3").querySelector("[title]")).toBeNull();
  });
});

describe("projects", () => {
  test("the latest update's author line carries the title, in the table and on the card", () => {
    render(
      <ProjectsView
        status="ready"
        projects={[
          project({ latestStatusUpdate: statusUpdate({ author: taraTitled }) }),
        ]}
        ownerName="Justin Salas"
        isOwner={false}
        onRetry={vi.fn()}
        now={now}
      />,
    );
    const table = screen.getByRole("table");
    expect(pillsIn(table, "Release manager")).toHaveLength(1);
    expectNamePillBadge(table, "Tara", "Release manager");
    expect(
      pillsIn(screen.getByRole("listitem"), "Release manager"),
    ).toHaveLength(1);
  });
});

describe("project", () => {
  function renderProject() {
    render(
      <ProjectView
        project={trail}
        issues={{
          status: "ready",
          data: issueList([issueRow({ assignee: taraTitled })]),
        }}
        statusUpdates={{
          status: "ready",
          data: {
            items: [
              statusUpdate({ author: taraTitled }),
              statusUpdate({ id: "su-2", author: tara }),
            ],
            nextCursor: null,
          },
        }}
        status={null}
        onStatusChange={vi.fn()}
        onRetryIssues={vi.fn()}
        onRetryStatusUpdates={vi.fn()}
        onNewIssue={vi.fn()}
        now={now}
      />,
    );
  }

  test("a status update reads name, title pill, Bot badge like every other view; the issue list's assignee never carries it", () => {
    renderProject();
    // the issue table (1440), its rows (375) and both updates are all in the DOM
    const pills = screen.getAllByTitle("Release manager");
    expect(pills).toHaveLength(1);
    const update = pills[0]?.closest("li");
    if (!update) throw new Error("no status update");
    expectNamePillBadge(update, "Tara", "Release manager");
    expect(pillsIn(screen.getByRole("table"), "Release manager")).toHaveLength(
      0,
    );
  });
});
