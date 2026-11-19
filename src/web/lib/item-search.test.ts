import { describe, expect, test } from "vitest";
import { validateItemSearch } from "@/lib/item-search";

describe("an item list's deep link", () => {
  test("a note status with no type is All", () => {
    expect(validateItemSearch({ status: "current" })).toEqual({
      status: undefined,
      type: undefined,
    });
  });

  test("a work status under Notes is All notes", () => {
    expect(validateItemSearch({ type: "note", status: "open" })).toEqual({
      status: undefined,
      type: "note",
    });
  });

  test("a status the type has is kept", () => {
    expect(validateItemSearch({ type: "note", status: "archived" })).toEqual({
      status: "archived",
      type: "note",
    });
    expect(validateItemSearch({ type: "todo", status: "done" })).toEqual({
      status: "done",
      type: "todo",
    });
  });
});
