import { describe, expect, test } from "vitest";
import { burnUpGeometry, niceMax } from "@/lib/burn-up";

const point = (date: string, scope: number, done: number) => ({
  date,
  scope,
  done,
});

describe("niceMax", () => {
  test.each([
    [1, 2],
    [2, 2],
    [3, 4],
    [5, 6],
    [9, 10],
    [10, 10],
    [11, 12],
    [28, 30],
    [31, 40],
    [99, 100],
    [130, 140],
    [1234, 1400],
  ])("%i rounds up to %i, whose half is whole", (value, max) => {
    expect(niceMax(value)).toBe(max);
    expect(Number.isInteger(max / 2)).toBe(true);
  });

  test("an empty or zero scale still has a top", () => {
    expect(niceMax(0)).toBe(2);
  });
});

describe("burnUpGeometry", () => {
  const history = [
    point("2026-10-28", 9, 0),
    point("2026-11-12", 18, 2),
    point("2026-11-28", 28, 5),
  ];

  test("ticks are 0, half and the rounded max, 0 on the baseline and max at the top", () => {
    const g = burnUpGeometry(history, 520);
    expect(g.ticks.map((t) => t.value)).toEqual([0, 15, 30]);
    expect(g.ticks[0]?.y).toBe(g.bottom);
    expect(g.ticks[2]?.y).toBe(g.top);
  });

  test("the lines start at the plot's left and end at its right, at their values", () => {
    const g = burnUpGeometry(history, 520);
    expect(g.scope[0]).toEqual([g.left, g.y(9)]);
    expect(g.scope.at(-1)).toEqual([g.plotRight, g.y(28)]);
    expect(g.done.at(-1)).toEqual([g.plotRight, g.y(5)]);
    expect(g.y(0)).toBe(g.bottom);
  });

  test("the right gutter fits the longer end label plus 8px", () => {
    const g = burnUpGeometry(history, 520);
    // "Scope 28" is the longer label
    expect(g.width - g.plotRight).toBe(8 + 8 * 7);
  });

  test("x follows the calendar, so weekly points sit a week apart", () => {
    const weekly = [
      point("2026-06-01", 4, 0),
      point("2026-06-08", 6, 1),
      point("2026-06-15", 7, 3),
      point("2026-06-18", 7, 4),
    ];
    const g = burnUpGeometry(weekly, 520);
    const xs = g.scope.map(([x]) => x);
    const span = g.plotRight - g.left;
    expect(xs[1]).toBeCloseTo(g.left + (span * 7) / 17);
    expect(xs[2]).toBeCloseTo(g.left + (span * 14) / 17);
    expect(xs[3]).toBe(g.plotRight);
  });

  test("x labels: the first day, the middle day and the last", () => {
    const g = burnUpGeometry(history, 520);
    expect(g.xLabels.map((l) => [l.date, l.anchor])).toEqual([
      ["2026-10-28", "start"],
      ["2026-11-12", "middle"],
      ["2026-11-28", "end"],
    ]);
  });

  test("two days apart draw no middle label", () => {
    const g = burnUpGeometry(
      [point("2026-11-27", 6, 0), point("2026-11-28", 9, 1)],
      520,
    );
    expect(g.xLabels.map((l) => l.date)).toEqual(["2026-11-27", "2026-11-28"]);
  });

  test("end labels that would overlap are pushed apart", () => {
    const g = burnUpGeometry(
      [point("2026-11-01", 20, 10), point("2026-11-28", 28, 28)],
      520,
    );
    expect(g.endLabels.done.y - g.endLabels.scope.y).toBeGreaterThanOrEqual(14);
  });
});
