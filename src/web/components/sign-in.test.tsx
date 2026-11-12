import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SignInView } from "@/components/sign-in";

test("a failed sign-in start shows its message above the button, announced", () => {
  const { rerender } = render(<SignInView onSignIn={vi.fn()} />);
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();

  rerender(
    <SignInView
      onSignIn={vi.fn()}
      error="GitHub sign-in isn't set up on this server."
    />,
  );
  expect(status).toHaveTextContent(
    "GitHub sign-in isn't set up on this server.",
  );
  const button = screen.getByRole("button", { name: "Continue with GitHub" });
  expect(status.compareDocumentPosition(button)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test("the sign-in card shows the mark beside the wordmark", () => {
  render(<SignInView onSignIn={vi.fn()} />);
  const main = screen.getByRole("main");
  const mark = main.querySelector("svg");
  expect(mark).toHaveAttribute("aria-hidden", "true");
  expect(mark?.querySelectorAll("rect")).toHaveLength(3);
  expect(mark?.nextElementSibling).toHaveTextContent("trail.");
});
