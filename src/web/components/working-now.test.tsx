import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  WorkingNow,
  type WorkingNowEntry,
  workingNowEntries,
} from "@/components/working-now";
import type { WebActorView } from "@/lib/api-types";
import { alpha, beta, issueRow, maya } from "@/test/fixtures";

const bot = (n: number): WebActorView => ({
  ...alpha,
  id: `a-bot-${n}`,
  name: `bot-${n}`,
});
const entriesOf = (count: number): WorkingNowEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    bot: bot(i + 1),
    item: { key: `TRL-${i + 1}`, title: `Item ${i + 1}` },
  }));

const strip = () => screen.getByRole("region", { name: "Working now" });
const entryLinks = () => within(strip()).getAllByRole("link");
const moreCounts = () =>
  [...strip().querySelectorAll<HTMLElement>("[data-more-count]")].map(
    (more) => [more.textContent, more.className],
  );

describe("WorkingNow", () => {
  test("renders nothing while no bot has an item in progress", () => {
    const { container } = render(<WorkingNow entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("one bot: the label, then its square teal avatar and the item key, linking to the item", () => {
    render(<WorkingNow entries={entriesOf(1)} />);
    expect(
      within(strip()).getByRole("heading", { name: "Working now" }),
    ).toBeInTheDocument();
    const [link] = entryLinks();
    expect(link).toHaveAccessibleName("bot-1 is working on TRL-1 Item 1");
    expect(link).toHaveAttribute("href", "/products/TRL/1");
    expect(link).toHaveTextContent("TRL-1");
    const avatar = within(link as HTMLElement).getByRole("img", {
      name: "bot-1, bot",
    });
    expect(avatar).toHaveClass("rounded-md", "bg-bot-muted", "text-bot");
    expect(moreCounts()).toEqual([]);
  });

  test("two: both show at every width, with no +N", () => {
    render(<WorkingNow entries={entriesOf(2)} />);
    for (const link of entryLinks()) {
      expect(link.closest("li")?.className ?? "").not.toMatch(/hidden/);
    }
    expect(moreCounts()).toEqual([]);
  });

  test("three: the third hides below lg, where +1 stands for it", () => {
    render(<WorkingNow entries={entriesOf(3)} />);
    const items = entryLinks().map((link) => link.closest("li"));
    expect(items[2]).toHaveClass("max-lg:hidden");
    expect(moreCounts()).toEqual([
      ["+1 more", expect.stringMatching(/(?:^| )lg:hidden/)],
    ]);
  });

  test("five or more: four from lg, then +N; two below lg, then +N", () => {
    render(<WorkingNow entries={entriesOf(6)} />);
    expect(entryLinks()).toHaveLength(4);
    expect(within(strip()).queryByText("TRL-5")).toBeNull();
    expect(moreCounts()).toEqual([
      ["+4 more", expect.stringMatching(/(?:^| )lg:hidden/)],
      ["+2 more", expect.stringContaining("max-lg:hidden")],
    ]);
  });
});

describe("workingNowEntries", () => {
  test("keeps items in progress with a bot assignee, most recently updated first", () => {
    const entries = workingNowEntries([
      issueRow({
        key: "TRL-1",
        status: "in_progress",
        assignee: alpha,
        updatedAt: "2026-11-11T09:00:00.000Z",
      }),
      issueRow({ key: "TRL-2", status: "in_progress", assignee: maya }),
      issueRow({ key: "TRL-3", status: "in_progress", assignee: null }),
      issueRow({ key: "TRL-4", status: "open", assignee: beta }),
      issueRow({
        key: "TRL-5",
        status: "in_progress",
        assignee: beta,
        updatedAt: "2026-11-11T10:00:00.000Z",
      }),
    ]);
    expect(entries.map((e) => [e.bot.name, e.item.key])).toEqual([
      ["Beta", "TRL-5"],
      ["Alpha", "TRL-1"],
    ]);
  });
});
