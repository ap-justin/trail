import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { leaks, server } from "./server";

// jsdom does not implement scrolling; the router calls it on navigation and jsdom logs "Not implemented" without it
window.scrollTo = () => {};
// jsdom has none of these; the feed watches its top with an IntersectionObserver and the
// theme reads the system setting. A test that needs a dark system replaces matchMedia.
Element.prototype.scrollIntoView = () => {};
window.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
} as unknown as typeof IntersectionObserver;
window.matchMedia = (query: string) =>
  ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList;

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  // unmount first: a request a mounted tree fires after the handlers are gone would trip the guard
  cleanup();
  server.resetHandlers();
  expect(leaks.splice(0), "requests no handler answered").toEqual([]);
});
afterAll(() => server.close());
