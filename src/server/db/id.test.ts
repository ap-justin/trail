import { expect, test } from "vitest";
import { newId } from "./id.js";

test("ids are UUIDv7 strings carrying their millisecond timestamp", () => {
  const id = newId(Date.UTC(2026, 10, 8, 8, 37, 15, 123));
  expect(id).toMatch(
    /^01a1ba4d-faf3-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("ids sort as text in creation order across milliseconds", () => {
  const ids = [newId(1_000), newId(2_000), newId(256_000), newId(1_000_000)];
  expect([...ids].sort()).toEqual(ids);
});
