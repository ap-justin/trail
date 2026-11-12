import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useMinuteClock } from "@/lib/use-minute-clock";

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-12T10:00:00.000Z") });
});
afterEach(() => {
  vi.useRealTimers();
});

test("moves on each minute, so relative times do not freeze", () => {
  const { result } = renderHook(() => useMinuteClock(undefined));
  expect(result.current.toISOString()).toBe("2026-11-12T10:00:00.000Z");
  act(() => vi.advanceTimersByTime(59_999));
  expect(result.current.toISOString()).toBe("2026-11-12T10:00:00.000Z");
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.toISOString()).toBe("2026-11-12T10:01:00.000Z");
});

test("a fixed clock is returned as given and never ticks", () => {
  const fixed = new Date("2026-01-01T00:00:00.000Z");
  const { result } = renderHook(() => useMinuteClock(fixed));
  act(() => vi.advanceTimersByTime(180_000));
  expect(result.current).toBe(fixed);
});
