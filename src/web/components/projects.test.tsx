import { render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { ProjectsView, type ProjectsViewProps } from "@/components/projects";
import { project, statusUpdate } from "@/test/fixtures";

const now = new Date("2026-11-11T09:53:00.000Z");

function renderProjects(overrides: Partial<ProjectsViewProps> = {}) {
  render(
    <ProjectsView
      status="ready"
      projects={[project()]}
      ownerName="Justin Salas"
      isOwner={false}
      onRetry={vi.fn()}
      now={now}
      {...overrides}
    />,
  );
}

// the table (1440) and the cards (375) are both in the DOM; CSS shows one
const table = () => screen.getByRole("table");
const card = () => {
  const item = screen.getByRole("listitem");
  return within(item);
};

describe("projects", () => {
  test("a project with a status update shows its health and the update's author", () => {
    renderProjects();
    expect(within(table()).getByText("On track")).toBeInTheDocument();
    expect(within(table()).getByText("Tara")).toBeInTheDocument();
    expect(within(table()).getByText("Bot")).toBeInTheDocument();
    expect(within(table()).getByText("41m ago")).toBeInTheDocument();
  });

  test('"No status update yet" shows no health pill', () => {
    renderProjects({
      projects: [project({ latestStatusUpdate: null, health: null })],
    });
    expect(screen.getAllByText("No status update yet")).toHaveLength(2);
    for (const word of ["On track", "At risk", "Off track"]) {
      expect(screen.queryByText(word)).not.toBeInTheDocument();
    }
  });

  test("Open shows the open count and In progress the in-progress count, nothing summed", () => {
    renderProjects({
      projects: [project({ openCount: 9, inProgressCount: 3 })],
    });
    const row = within(table()).getAllByRole("row")[1];
    if (!row) throw new Error("no project row");
    const cells = within(row).getAllByRole("cell");
    expect(cells[3]).toHaveTextContent(/^9$/);
    expect(cells[4]).toHaveTextContent(/^3$/);
    expect(card().getByText("9 open · 3 in progress")).toBeInTheDocument();
  });

  test("a card reads name, the update, its author and age, then the counts", () => {
    renderProjects();
    const item = screen.getByRole("listitem");
    const order = [
      within(item).getByRole("link", { name: "TRL trail" }),
      within(item).getByText(/^SSE feed shipped/),
      within(item).getByText("Tara"),
      within(item).getByText("41m ago"),
      within(item).getByText("9 open · 3 in progress"),
    ];
    for (const [before, after] of order
      .slice(0, -1)
      .map((el, i) => [el, order[i + 1]])) {
      if (!before || !after) throw new Error("missing card part");
      expect(
        before.compareDocumentPosition(after) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  test("each project links to its page", () => {
    renderProjects();
    for (const link of screen.getAllByRole("link", { name: "TRL trail" })) {
      expect(link).toHaveAttribute("href", "/projects/TRL");
    }
  });

  test("a status update shows its words, not its Markdown, in the table and the card", () => {
    renderProjects({
      projects: [
        project({
          latestStatusUpdate: statusUpdate({
            body: "**Shipped** the `invite` flow\n\n- next: SSE",
          }),
        }),
      ],
    });
    for (const scope of [within(table()), card()]) {
      const text = scope.getByText(/Shipped/).closest("p");
      expect(text).toHaveTextContent("Shipped the invite flow next: SSE");
      expect(text).not.toHaveTextContent("**");
      expect(text).not.toHaveTextContent("`");
    }
  });

  test("a person with no projects is told to ask the owner by name", () => {
    renderProjects({ projects: [] });
    expect(
      screen.getByRole("heading", { name: "No projects yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ask Justin Salas to give you access to a project."),
    ).toBeInTheDocument();
  });

  test("a failed load offers Try again", async () => {
    const onRetry = vi.fn();
    renderProjects({ status: "error", onRetry });
    screen.getByRole("button", { name: "Try again" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
