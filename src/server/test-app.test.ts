import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { atFakeTime, atFakeTimeAsync, setupTestApp } from "./test-app.js";

setupTestApp();

afterEach(() => vi.useRealTimers());

test("a fetch to a URL no fake answers rejects instead of reaching the network", async () => {
  await expect(fetch("https://example.com/")).rejects.toThrow(
    "https://example.com/",
  );
});

test("the fake clock leaves a caller's own fake timers on, at the time they had", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  const callers = new Date("2030-01-01T00:00:00Z");
  vi.setSystemTime(callers);

  const [during] = atFakeTime([() => Date.now()]);
  expect(during).toBeLessThan(callers.getTime());
  expect(vi.isFakeTimers()).toBe(true);
  expect(Date.now()).toBe(callers.getTime());

  const [duringAsync] = await atFakeTimeAsync([async () => Date.now()]);
  expect(duringAsync).toBeLessThan(callers.getTime());
  expect(vi.isFakeTimers()).toBe(true);
  expect(Date.now()).toBe(callers.getTime());

  // the caller's setTimeout is still the fake one
  let fired = false;
  setTimeout(() => {
    fired = true;
  }, 1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fired).toBe(true);
});

test("with no fake timers on, the fake clock stamps in order and then the real clock is back", async () => {
  const real = Date.now();
  const stamps = [
    ...atFakeTime([() => Date.now(), () => Date.now()]),
    ...(await atFakeTimeAsync([async () => Date.now()])),
  ];
  expect(stamps[0]).toBeLessThan(stamps[1] as number);
  expect(stamps[1]).toBeLessThan(stamps[2] as number);
  expect(stamps[2]).toBeLessThan(real);
  expect(vi.isFakeTimers()).toBe(false);
  expect(Date.now()).toBeGreaterThanOrEqual(real);
});

test("fake timers on without the Date are refused by name, not silently stamped at real time", () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  expect(() => atFakeTime([() => 1])).toThrow("Date");
  expect(vi.isFakeTimers()).toBe(true);
});

test("a fetch to a loopback server still goes through", async () => {
  const server = createServer((_, res) => res.end("hi"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe("hi");
  } finally {
    server.close();
  }
});
