import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { statusesOf, statusFilterOf } from "@/lib/item-status";

describe("the status tabs a type has", () => {
  test("notes have current and archived", () => {
    expect(statusesOf("note")).toEqual(["current", "archived"]);
  });

  test("work types and All have the work statuses", () => {
    for (const type of ["issue", "todo", null] as const) {
      expect(statusesOf(type)).toEqual([
        "open",
        "in_progress",
        "done",
        "canceled",
      ]);
    }
  });
});

describe("a tab value back to its filter", () => {
  test("a work or note status is itself", () => {
    expect(statusFilterOf("in_progress")).toBe("in_progress");
    expect(statusFilterOf("archived")).toBe("archived");
  });

  test("All, triage and anything unknown are null", () => {
    expect(statusFilterOf("all")).toBeNull();
    expect(statusFilterOf("triage")).toBeNull();
    expect(statusFilterOf("memo")).toBeNull();
  });
});

// validateSearch is not code-split: whatever these modules import at runtime ships in the
// entry chunk on every cold load, so a component import here drags its whole graph up front
describe("search validation loads no components", () => {
  test.each(["item-search.ts", "item-status.ts"])(
    "%s imports components as types only",
    (file) => {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const isTypeOnly = (clause: string) =>
        clause.startsWith("type ") ||
        clause
          .replace(/[{}]/g, "")
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
          .every((name) => name.startsWith("type "));
      const runtime = [
        ...source.matchAll(
          /^import\s+([^;]*?)\s+from\s+"(@\/components[^"]*)"/gm,
        ),
      ]
        .filter(([, clause = ""]) => !isTypeOnly(clause))
        .map(([, , from]) => from);
      expect(runtime).toEqual([]);
    },
  );
});
