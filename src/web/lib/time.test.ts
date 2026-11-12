import { describe, expect, test } from "vitest";
import { formatAbsolute, formatDayHeader, formatRelative } from "@/lib/time";

// local-time constructors keep these independent of the machine's time zone
const now = new Date(2026, 10, 11, 15, 0, 0);
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const at = (...args: [number, number, number, number, number]) =>
  new Date(...args).toISOString();

describe("formatRelative", () => {
  test.each([
    [0, "just now"],
    [59_999, "just now"],
    [60_000, "1m"],
    [59 * 60_000 + 59_999, "59m"],
    [60 * 60_000, "1h"],
    [14 * 60 * 60_000 + 59 * 60_000, "14h"],
  ])("%i ms ago → %s", (ms, expected) => {
    expect(formatRelative(ago(ms), now)).toBe(expected);
  });

  test("an earlier day reads as its date, even under 24 hours", () => {
    expect(formatRelative(at(2026, 10, 10, 23, 30), now)).toBe("Nov 10");
  });

  test("another year carries the year", () => {
    expect(formatRelative(at(2025, 10, 10, 9, 0), now)).toBe("Nov 10, 2025");
  });
});

describe("formatAbsolute", () => {
  test.each([
    [at(2026, 10, 10, 9, 5), "Nov 10, 09:05"],
    [at(2026, 10, 10, 0, 0), "Nov 10, 00:00"],
    [at(2026, 10, 10, 23, 59), "Nov 10, 23:59"],
  ])("%s → %s", (iso, expected) => {
    expect(formatAbsolute(iso)).toBe(expected);
  });
});

describe("formatDayHeader", () => {
  test.each([
    [at(2026, 10, 11, 0, 0), "Today"],
    [at(2026, 10, 10, 23, 59), "Yesterday"],
    [at(2026, 10, 10, 0, 0), "Yesterday"],
    [at(2026, 10, 9, 23, 59), "Nov 9"],
  ])("%s → %s", (iso, expected) => {
    expect(formatDayHeader(iso, now)).toBe(expected);
  });

  test("Yesterday crosses a month boundary", () => {
    const first = new Date(2026, 11, 1, 8, 0);
    expect(formatDayHeader(at(2026, 10, 30, 20, 0), first)).toBe("Yesterday");
  });
});
