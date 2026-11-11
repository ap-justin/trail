import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { leaks, server } from "./server";

// jsdom does not implement scrolling; the router calls it on navigation and jsdom logs "Not implemented" without it
window.scrollTo = () => {};

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  server.resetHandlers();
  cleanup();
  expect(leaks.splice(0), "requests no handler answered").toEqual([]);
});
afterAll(() => server.close());
