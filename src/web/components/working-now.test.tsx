import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { WorkingNow } from "@/components/working-now";
import type { WebActorView, WebWorkingNowView } from "@/lib/api-types";
import { alpha } from "@/test/fixtures";

const bot = (n: number, name = `bot-${n}`): WebActorView => ({
  ...alpha,
  id: `a-bot-${n}`,
  name,
});
/**
 * `count` entries, as the server sends them; `total` defaults to that count. `names`
 * replaces the first bots' names.
 */
const view = (
  count: number,
  total = count,
  names: string[] = [],
): WebWorkingNowView => ({
  total,
  entries: Array.from({ length: count }, (_, i) => ({
    bot: bot(i + 1, names[i]),
    item: { key: `TRL-${i + 1}`, title: `Item ${i + 1}` },
    productKey: "TRL",
  })),
});

const strip = () => screen.getByRole("region", { name: "Working now" });
const entryLinks = () => within(strip()).getAllByRole("link");
const moreCounts = () =>
  [...strip().querySelectorAll<HTMLElement>("[data-more-count]")].map(
    (more) => [more.textContent, more.className],
  );

describe("WorkingNow", () => {
  test("renders nothing before the read lands or while total is 0", () => {
    const { container, rerender } = render(
      <WorkingNow workingNow={undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<WorkingNow workingNow={view(0)} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("one bot: the label, then its square teal avatar, its name and the item key, linking to the item", () => {
    render(<WorkingNow workingNow={view(1)} />);
    expect(
      within(strip()).getByRole("heading", { name: "Working now" }),
    ).toBeInTheDocument();
    const [link] = entryLinks();
    expect(link).toHaveAccessibleName("bot-1 TRL-1, Item 1, bot");
    expect(link).toHaveAttribute("href", "/products/TRL/1");
    expect(link).toHaveTextContent("bot-1TRL-1");
    const avatar = within(link as HTMLElement).getByRole("img", {
      name: "bot-1, bot",
    });
    expect(avatar).toHaveClass("rounded-md", "bg-bot-muted", "text-bot");
    expect(moreCounts()).toEqual([]);
  });

  test("the link's name starts with its visible text, name then key (label in name)", () => {
    render(<WorkingNow workingNow={view(1)} />);
    const [link] = entryLinks();
    const visible = [
      within(link as HTMLElement).getByText("bot-1"),
      within(link as HTMLElement).getByText("TRL-1"),
    ]
      .map((part) => part.textContent)
      .join(" ");
    expect(visible).toBe("bot-1 TRL-1");
    expect(link).toHaveAccessibleName(
      expect.stringMatching(/^bot-1 TRL-1, Item 1, bot$/),
    );
  });

  test("the name truncates and the key does not", () => {
    render(<WorkingNow workingNow={view(1)} />);
    const [link] = entryLinks();
    const name = within(link as HTMLElement).getByText("bot-1");
    expect(name).toHaveClass("min-w-0", "truncate");
    expect(within(link as HTMLElement).getByText("TRL-1")).toHaveClass(
      "whitespace-nowrap",
    );
    expect(link).toHaveClass("min-w-0");
    expect(link?.closest("li")).toHaveClass("min-w-0");
  });

  test("below lg a name of up to 8 characters keeps every letter; a longer one truncates", () => {
    render(<WorkingNow workingNow={view(2, 2, ["olivetta", "beta-relay"])} />);
    const short = within(strip()).getByText("olivetta");
    expect(short).toHaveClass("max-lg:shrink-0", "truncate");
    const long = within(strip()).getByText("beta-relay");
    expect(long).toHaveClass("min-w-0", "truncate");
    expect(long).not.toHaveClass("max-lg:shrink-0");
  });

  test("the link draws a focus outline", () => {
    render(<WorkingNow workingNow={view(1)} />);
    const [link] = entryLinks();
    expect(link).toHaveClass(
      "focus-visible:outline-2",
      "focus-visible:outline-ring",
    );
    expect(link?.className).not.toMatch(/(?:^| )outline-none(?: |$)/);
  });

  test("two: both show at every width, with no +N", () => {
    render(<WorkingNow workingNow={view(2)} />);
    for (const link of entryLinks()) {
      expect(link.closest("li")?.className ?? "").not.toMatch(/hidden/);
    }
    expect(moreCounts()).toEqual([]);
  });

  test("three: the third hides below lg, where +1 stands for it", () => {
    render(<WorkingNow workingNow={view(3)} />);
    const items = entryLinks().map((link) => link.closest("li"));
    expect(items[2]).toHaveClass("max-lg:hidden");
    expect(moreCounts()).toEqual([
      ["+1 more", expect.stringMatching(/(?:^| )lg:hidden/)],
    ]);
  });

  test("five or more: four from lg, then +N; two below lg, then +N", () => {
    render(<WorkingNow workingNow={view(6)} />);
    expect(entryLinks()).toHaveLength(4);
    expect(within(strip()).queryByText("TRL-5")).toBeNull();
    expect(moreCounts()).toEqual([
      ["+4 more", expect.stringMatching(/(?:^| )lg:hidden/)],
      ["+2 more", expect.stringContaining("max-lg:hidden")],
    ]);
  });

  test("below lg, two 8-character names show both, with +N from total; four from lg", () => {
    render(<WorkingNow workingNow={view(5, 7, ["alpha-01", "beta-002"])} />);
    const items = entryLinks().map((link) => link.closest("li"));
    expect(items).toHaveLength(4);
    expect(items[0]?.className).not.toMatch(/hidden/);
    expect(items[1]?.className).not.toMatch(/hidden/);
    expect(items[2]).toHaveClass("max-lg:hidden");
    expect(items[3]).toHaveClass("max-lg:hidden");
    expect(moreCounts()).toEqual([
      ["+5 more", expect.stringMatching(/(?:^| )lg:hidden/)],
      ["+3 more", expect.stringContaining("max-lg:hidden")],
    ]);
  });

  test.each([
    ["the first", ["alpha-relay", "beta"]],
    ["the second", ["alpha", "beta-relay"]],
  ])(
    "below lg, a 9+ character name as %s entry leaves one shown, with +N for the rest; four from lg",
    (_, names) => {
      render(<WorkingNow workingNow={view(5, 7, names)} />);
      const items = entryLinks().map((link) => link.closest("li"));
      expect(items).toHaveLength(4);
      expect(items[0]?.className).not.toMatch(/hidden/);
      for (const item of items.slice(1)) {
        expect(item).toHaveClass("max-lg:hidden");
      }
      expect(moreCounts()).toEqual([
        ["+6 more", expect.stringMatching(/(?:^| )lg:hidden/)],
        ["+3 more", expect.stringContaining("max-lg:hidden")],
      ]);
    },
  );

  test("two bots with a 9+ character name: one below lg and +1, both from lg", () => {
    render(<WorkingNow workingNow={view(2, 2, ["alpha", "beta-relay"])} />);
    const items = entryLinks().map((link) => link.closest("li"));
    expect(items[0]?.className).not.toMatch(/hidden/);
    expect(items[1]).toHaveClass("max-lg:hidden");
    expect(moreCounts()).toEqual([
      ["+1 more", expect.stringMatching(/(?:^| )lg:hidden/)],
    ]);
  });

  test("+N counts from total, past the 12 entries the server sends", () => {
    render(<WorkingNow workingNow={view(12, 30)} />);
    expect(entryLinks()).toHaveLength(4);
    expect(moreCounts()).toEqual([
      ["+28 more", expect.stringMatching(/(?:^| )lg:hidden/)],
      ["+26 more", expect.stringContaining("max-lg:hidden")],
    ]);
  });
});
