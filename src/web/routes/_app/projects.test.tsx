import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, test } from "vitest";
import { renderApp, signedInAs } from "@/test/app";
import { projectRow, teamAccessRow } from "@/test/fixtures";
import { server } from "@/test/server";

const currentSection = () => {
  const nav = screen.getAllByRole("navigation")[0];
  if (!nav) throw new Error("no navigation");
  return within(nav)
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent);
};

describe("projects list", () => {
  test("/projects reads every page of projects and lists them, with Projects current", async () => {
    signedInAs("member");
    const cursors: (string | null)[] = [];
    server.use(
      http.get("/api/web/projects", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        return HttpResponse.json(
          cursor === null
            ? { items: [projectRow()], nextCursor: "c1" }
            : { items: [teamAccessRow()], nextCursor: null },
        );
      }),
    );
    renderApp("/projects");
    expect(await screen.findAllByText("Team access")).not.toHaveLength(0);
    expect(screen.getAllByText("Human UI launch")).not.toHaveLength(0);
    expect(cursors).toEqual([null, "c1"]);
    expect(currentSection()).toEqual(["Projects"]);
  });

  test("stops reading after 10 pages", async () => {
    signedInAs("member");
    let pages = 0;
    server.use(
      http.get("/api/web/projects", () => {
        pages++;
        return HttpResponse.json({
          items: [projectRow({ slug: `p${pages}`, name: `Project ${pages}` })],
          nextCursor: `c${pages}`,
        });
      }),
    );
    renderApp("/projects");
    expect(await screen.findAllByText("Project 10")).not.toHaveLength(0);
    expect(pages).toBe(10);
  });
});
