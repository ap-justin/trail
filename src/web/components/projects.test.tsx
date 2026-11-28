import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { ProjectsView, type ProjectsViewProps } from "@/components/projects";
import { projectRow, teamAccessRow } from "@/test/fixtures";

const now = new Date("2026-11-11T09:53:00.000Z");

function renderProjects(overrides: Partial<ProjectsViewProps> = {}) {
  render(
    <ProjectsView
      status="ready"
      projects={[projectRow()]}
      onRetry={vi.fn()}
      now={now}
      {...overrides}
    />,
  );
}

const table = () => screen.getByRole("table");
const rowFor = (slug: string) => {
  const row = table().querySelector(`[data-project-slug="${slug}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no ${slug} row`);
  return row;
};
const cardFor = (slug: string) => {
  const card = screen
    .getAllByRole("listitem")
    .find((li) => li.dataset.projectSlug === slug);
  if (!card) throw new Error(`no ${slug} card`);
  return card;
};
const cellsOf = (row: HTMLElement) => within(row).getAllByRole("cell");

describe("projects", () => {
  test("the columns read Project, Health, Products, Lead, Target, Latest status update, Progress, Updated", () => {
    renderProjects();
    expect(
      within(table())
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Project",
      "Health",
      "Products",
      "Lead",
      "Target",
      "Latest status update",
      "Progress",
      "Updated",
    ]);
  });

  test("a row reads name and goal, health, product keys, the lead with their avatar, target, update, progress and age", () => {
    renderProjects();
    const cells = cellsOf(rowFor("human-ui"));
    expect(
      within(cells[0] as HTMLElement).getByRole("link", {
        name: "Human UI launch",
      }),
    ).toHaveAttribute("href", "/projects/human-ui");
    expect(cells[0]).toHaveTextContent(
      "People read the team's work in trail without asking a bot",
    );
    expect(cells[1]).toHaveTextContent(/^At risk$/);
    expect(cells[2]).toHaveTextContent(/^DOC OPB TRL\s*$/);
    expect(cells[3]).toHaveTextContent(/Gamma$/);
    expect(
      within(cells[3] as HTMLElement).getByRole("img", { name: "Gamma, bot" }),
    ).toBeVisible();
    expect(cells[4]).toHaveTextContent(/^Dec 4$/);
    expect(cells[5]).toHaveTextContent(/Feed and product pages are drawn/);
    expect(cells[6]).toHaveTextContent(/^18 of 31$/);
    expect(
      [...(cells[6] as HTMLElement).querySelectorAll("[data-segment]")].map(
        (s) => [
          s.getAttribute("data-segment"),
          (s as HTMLElement).style.flexGrow,
        ],
      ),
    ).toEqual([
      ["done", "18"],
      ["in_progress", "3"],
      ["open", "10"],
    ]);
    expect(cells[7]).toHaveTextContent(/^41m$/);
  });

  test('no target reads "None" in the table and drops Target from the card', () => {
    renderProjects({ projects: [projectRow({ targetDate: null })] });
    expect(cellsOf(rowFor("human-ui"))[4]).toHaveTextContent(/^None$/);
    expect(cardFor("human-ui")).not.toHaveTextContent("Target");
  });

  test("a target in another year keeps its year and may wrap, so it never runs into the next column", () => {
    renderProjects({ projects: [projectRow({ targetDate: "2027-01-15" })] });
    const target = cellsOf(rowFor("human-ui"))[4];
    expect(target).toHaveTextContent(/^Jan 15, 2027$/);
    expect(target).toHaveClass("whitespace-normal");
  });

  test("a card shows its progress after the latest update, and ends on the keys and the target", () => {
    renderProjects({ projects: [teamAccessRow()] });
    const card = cardFor("team-access");
    expect(card).toHaveTextContent(
      /6 of 10 items done\s*TRL\s*· Target Nov 30$/,
    );
    expect(card).not.toHaveTextContent("open");
    expect(card.querySelector("[data-bar]")).not.toBeNull();
  });

  test("no items yet: the words and no bar, in the table and on the card", () => {
    renderProjects({
      projects: [
        projectRow({ itemsInScope: 0, itemsDone: 0, itemsInProgress: 0 }),
      ],
    });
    expect(cellsOf(rowFor("human-ui"))[6]).toHaveTextContent(/^No items yet$/);
    expect(cardFor("human-ui")).toHaveTextContent("No items yet");
    expect(document.querySelector("[data-bar]")).toBeNull();
  });

  test("a wrapped title keeps its health on the first line", () => {
    renderProjects();
    const title = within(cardFor("human-ui")).getByRole("link", {
      name: "Human UI launch",
    });
    expect(title.parentElement).toHaveClass("items-start");
  });

  test("health shows only beside a status update", () => {
    renderProjects({
      projects: [projectRow({ latestStatusUpdate: null, health: "at_risk" })],
    });
    expect(screen.queryByText("At risk")).not.toBeInTheDocument();
    expect(screen.getAllByText("No status update yet")).toHaveLength(2);
  });

  test("an empty list says so", () => {
    renderProjects({ projects: [] });
    expect(
      screen.getByRole("heading", { name: "No projects yet" }),
    ).toBeInTheDocument();
  });

  test("a failed load says so and offers Try again", async () => {
    const onRetry = vi.fn();
    renderProjects({ status: "error", onRetry });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't load projects",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
