import { describe, expect, test } from "vitest";
import { validateFeedSearch, validateItemSearch } from "@/lib/item-search";

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

  test("an unknown type is All, and a work status stays valid under All", () => {
    expect(validateItemSearch({ type: "memo", status: "open" })).toEqual({
      status: "open",
      type: undefined,
    });
  });

  test("a note status under a work type is All of that type", () => {
    expect(validateItemSearch({ type: "issue", status: "current" })).toEqual({
      status: undefined,
      type: "issue",
    });
  });

  test("a status the type has is kept", () => {
    expect(validateItemSearch({ type: "note", status: "current" })).toEqual({
      status: "current",
      type: "note",
    });
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

describe("the feed's deep link", () => {
  test("a type of note is kept, as issue and todo are", () => {
    for (const type of ["note", "issue", "todo"]) {
      expect(validateFeedSearch({ type }).type, type).toBe(type);
    }
  });

  test("an unknown type is All", () => {
    expect(validateFeedSearch({ type: "memo" }).type).toBeUndefined();
    expect(validateFeedSearch({ type: "epic" }).type).toBeUndefined();
  });

  test("a status is not a feed filter, whatever the type", () => {
    expect(validateFeedSearch({ type: "note", status: "archived" })).toEqual({
      actor: undefined,
      product: undefined,
      project: undefined,
      type: "note",
    });
  });
});
