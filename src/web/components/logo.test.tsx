import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Logo, Mark } from "@/components/logo";

test("Logo is one aria-hidden mark of three pills, one of them the bot head, beside the wordmark", () => {
  const { container } = render(<Logo />);
  expect(container.querySelectorAll("svg")).toHaveLength(1);
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  expect(container.querySelectorAll("svg rect")).toHaveLength(3);
  const pills = [...container.querySelectorAll("svg rect")];
  const head = pills.filter((r) => r.getAttribute("y") === "4");
  expect(head).toHaveLength(1);
  expect(head[0]).toHaveClass("fill-bot");
  for (const body of pills.filter((r) => r !== head[0])) {
    expect(body).toHaveClass("fill-foreground");
    expect(body).not.toHaveClass("fill-bot");
  }
  expect(container).toHaveTextContent("trail.");
});

test("a mono Mark paints all three pills in the current colour", () => {
  const { container } = render(<Mark mono />);
  expect(container.querySelectorAll("rect.fill-current")).toHaveLength(3);
  expect(container.querySelector(".fill-bot")).toBeNull();
});
