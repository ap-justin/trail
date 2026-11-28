import { describe, expect, test } from "vitest";
import {
  type ProgressItem,
  projectHistory,
  projectProgress,
} from "./progress.js";

const joined = new Date("2026-11-01T10:00:00Z");
const now = new Date("2026-11-28T12:00:00Z");
const products = [
  { key: "ALP", name: "Alpha" },
  { key: "BET", name: "Beta" },
];

/** An item of `productKey` in `status`, joined on 2026-11-01. */
const item = (
  productKey: string,
  status: ProgressItem["status"],
  estimate: number | null = null,
  extra: Partial<ProgressItem> = {},
): ProgressItem => ({
  productKey,
  status,
  estimate,
  completedAt:
    status === "done" || status === "canceled"
      ? new Date("2026-11-10T10:00:00Z")
      : null,
  joinedAt: joined,
  ...extra,
});

describe("projectProgress", () => {
  test("a mixed project: scope is open, in progress and done; triage and canceled stand apart", () => {
    const items = [
      item("ALP", "open", 2),
      item("ALP", "in_progress", 3.25),
      item("ALP", "done", 1.5),
      item("ALP", "triage", 8),
      item("BET", "canceled", 5),
      item("BET", "open"),
      item("BET", "done"),
    ];
    expect(projectProgress(items, products, null, now)).toEqual({
      itemsInScope: 5,
      itemsDone: 2,
      itemsInProgress: 1,
      itemsOpen: 2,
      itemsTriage: 1,
      itemsCanceled: 1,
      donePercent: 40,
      hoursEstimated: 6.8,
      hoursDone: 1.5,
      hoursLeft: 5.3,
      hoursDonePercent: 22,
      unfinishedWithoutEstimate: 1,
      target: { date: null, status: "none", daysAway: null },
      byProduct: [
        {
          key: "ALP",
          name: "Alpha",
          inScope: 3,
          done: 1,
          inProgress: 1,
          open: 1,
          hoursLeft: 5.3,
          unfinishedWithoutEstimate: 0,
        },
        {
          key: "BET",
          name: "Beta",
          inScope: 2,
          done: 1,
          inProgress: 0,
          open: 1,
          hoursLeft: 0,
          unfinishedWithoutEstimate: 1,
        },
      ],
    });
  });

  const many = (done: number, open: number, estimate: number | null = null) => [
    ...Array.from({ length: done }, () => item("ALP", "done", estimate)),
    ...Array.from({ length: open }, () => item("ALP", "open", estimate)),
  ];
  const percents = (items: ProgressItem[]) => {
    const p = projectProgress(items, products, null, now);
    return [p.donePercent, p.hoursDonePercent];
  };

  test("1 of 300 done shows 1, not 0", () => {
    expect(percents(many(1, 299, 1))).toEqual([1, 1]);
  });

  test("299 of 300 done never shows 100", () => {
    expect(percents(many(299, 1, 1))).toEqual([99, 99]);
  });

  test("an empty scope is 0", () => {
    expect(percents([item("ALP", "triage", 3)])).toEqual([0, 0]);
  });

  test("all done is 100 by items and by hours", () => {
    expect(percents(many(3, 0, 2))).toEqual([100, 100]);
  });

  test("with no estimates the hours are 0 and every unfinished item is unestimated", () => {
    const p = projectProgress(many(2, 3), products, null, now);
    expect([
      p.hoursEstimated,
      p.hoursDone,
      p.hoursLeft,
      p.hoursDonePercent,
      p.unfinishedWithoutEstimate,
      p.donePercent,
    ]).toEqual([0, 0, 0, 0, 3, 40]);
  });

  test("estimated items count toward hours, unestimated ones only toward unfinishedWithoutEstimate", () => {
    const p = projectProgress(
      [
        item("ALP", "done", 4),
        item("ALP", "done"),
        item("ALP", "open", 0.04),
        item("ALP", "in_progress"),
      ],
      products,
      null,
      now,
    );
    expect([
      p.hoursEstimated,
      p.hoursDone,
      p.hoursLeft,
      p.hoursDonePercent,
      p.unfinishedWithoutEstimate,
    ]).toEqual([4, 4, 0, 99, 1]);
  });

  test("the target against the UTC day: upcoming, today, overdue with negative daysAway", () => {
    // late on the 28th in UTC is still the 28th, whatever the server's zone
    const late = new Date("2026-11-28T23:59:00Z");
    const t = (date: string) => projectProgress([], [], date, late).target;
    expect(t("2026-12-01")).toEqual({
      date: "2026-12-01",
      status: "upcoming",
      daysAway: 3,
    });
    expect(t("2026-11-28")).toEqual({
      date: "2026-11-28",
      status: "today",
      daysAway: 0,
    });
    expect(t("2026-11-20")).toEqual({
      date: "2026-11-20",
      status: "overdue",
      daysAway: -8,
    });
  });
});

describe("projectHistory", () => {
  const at = (iso: string) => new Date(iso);
  const day = (d: string) => `2026-11-${d}`;

  test("end-of-day cumulative scope and done; done on the later of completing and joining", () => {
    const items: ProgressItem[] = [
      item("ALP", "open", null, { joinedAt: at("2026-11-24T09:00:00Z") }),
      // completed before it joined: done the day it joined
      item("ALP", "done", null, {
        joinedAt: at("2026-11-25T23:30:00Z"),
        completedAt: at("2026-11-20T10:00:00Z"),
      }),
      item("BET", "done", null, {
        joinedAt: at("2026-11-24T10:00:00Z"),
        completedAt: at("2026-11-27T00:10:00Z"),
      }),
      // triage and canceled are outside scope, even the earliest to join
      item("ALP", "triage", null, { joinedAt: at("2026-11-01T10:00:00Z") }),
      item("BET", "canceled", null, {
        joinedAt: at("2026-11-02T10:00:00Z"),
        completedAt: at("2026-11-25T10:00:00Z"),
      }),
    ];
    expect(projectHistory(items, now)).toEqual([
      { date: day("24"), scope: 2, done: 0 },
      { date: day("25"), scope: 3, done: 1 },
      { date: day("26"), scope: 3, done: 1 },
      { date: day("27"), scope: 3, done: 2 },
      { date: day("28"), scope: 3, done: 2 },
    ]);
  });

  test("an empty scope has no history", () => {
    expect(projectHistory([item("ALP", "triage")], now)).toEqual([]);
  });

  test("past 120 days, one point a week from the first day, and today last", () => {
    const first = at("2026-07-01T08:00:00Z");
    const points = projectHistory(
      [
        item("ALP", "open", null, { joinedAt: first }),
        item("ALP", "done", null, {
          joinedAt: first,
          completedAt: at("2026-07-10T08:00:00Z"),
        }),
      ],
      now,
    );
    // 2026-07-01 to 2026-11-28 is 150 days: 22 weeks and 3 days
    expect(points).toHaveLength(23);
    expect(points.slice(0, 3)).toEqual([
      { date: "2026-07-01", scope: 2, done: 0 },
      { date: "2026-07-08", scope: 2, done: 0 },
      { date: "2026-07-15", scope: 2, done: 1 },
    ]);
    expect(points.slice(-2)).toEqual([
      { date: "2026-11-25", scope: 2, done: 1 },
      { date: "2026-11-28", scope: 2, done: 1 },
    ]);
  });

  test("at 120 days or less, every day", () => {
    const points = projectHistory(
      [item("ALP", "open", null, { joinedAt: at("2026-07-31T08:00:00Z") })],
      now,
    );
    expect(points).toHaveLength(121);
    expect(points[1]).toEqual({ date: "2026-08-01", scope: 1, done: 0 });
  });
});
