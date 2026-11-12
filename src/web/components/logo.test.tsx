import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Logo, Mark } from "@/components/logo";

test("Logo is one aria-hidden mark of three pills, one of them the bot head, beside the wordmark", () => {
  const { container } = render(<Logo />);
  expect(container.querySelectorAll("svg")).toHaveLength(1);
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  expect(container.querySelectorAll("svg rect")).toHaveLength(3);
  expect(container.querySelectorAll("svg rect.fill-bot")).toHaveLength(1);
  expect(container).toHaveTextContent("trail.");
});

test("a mono Mark paints all three pills in the current colour", () => {
  const { container } = render(<Mark mono />);
  expect(container.querySelectorAll("rect.fill-current")).toHaveLength(3);
  expect(container.querySelector(".fill-bot")).toBeNull();
});

test("index.html links the favicons", () => {
  const html = readFileSync("src/web/index.html", "utf8");
  expect(html).toContain(
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
  );
  expect(html).toContain(
    '<link rel="icon" href="/favicon.ico" sizes="48x48" />',
  );
  expect(html).toContain(
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  );
});
