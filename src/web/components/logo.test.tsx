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
