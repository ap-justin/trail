import { describe, expect, test } from "vitest";
import { loadableAfter } from "@/lib/loadable";

const pending = { data: undefined, isError: false };
const failed = { data: undefined, isError: true };

describe("a read that waits on another", () => {
  test("fails when the one it waits on failed before it ran", () => {
    expect(loadableAfter(pending, failed)).toEqual({ status: "error" });
  });

  test("loads while the one it waits on is in flight", () => {
    expect(loadableAfter(pending, pending)).toEqual({ status: "loading" });
  });

  test("keeps its own rows when the one it waits on fails a refetch", () => {
    expect(loadableAfter({ data: 1, isError: false }, failed)).toEqual({
      status: "ready",
      data: 1,
    });
  });
});
