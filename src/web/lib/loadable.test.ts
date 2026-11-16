import { describe, expect, test } from "vitest";
import { loadableAfter, pagingOf } from "@/lib/loadable";

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

describe("an infinite query's paging", () => {
  const query = (pages: number[][]) => ({
    data: { pages: pages.map((items) => ({ items })) },
    hasNextPage: true,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage: () => Promise.resolve(),
  });

  test("counts the pages and finds where the last one begins", () => {
    expect(pagingOf(query([[1, 2, 3], [4, 5], [6]]))).toMatchObject({
      pageCount: 3,
      lastPageStart: 5,
    });
  });

  test("before any page, there are none", () => {
    expect(pagingOf({ ...query([]), data: undefined })).toMatchObject({
      pageCount: 0,
      lastPageStart: 0,
    });
  });
});
