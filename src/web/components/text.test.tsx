import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { KeyPill, LabelChip } from "@/components/text";

describe("KeyPill", () => {
  test("is a muted mono pill that never shrinks or wraps", () => {
    render(<KeyPill>OPB</KeyPill>);
    const pill = screen.getByText("OPB");
    expect(pill).toHaveClass(
      "font-mono",
      "text-2xs",
      "rounded-sm",
      "bg-muted",
      "ring-1",
      "ring-border",
      "text-muted-foreground",
      "shrink-0",
      "whitespace-nowrap",
    );
    expect(pill).not.toHaveClass("truncate");
  });

  test("reads as a key, not a label chip", () => {
    render(
      <>
        <KeyPill>OPB</KeyPill>
        <LabelChip name="frontend" />
      </>,
    );
    expect(screen.getByText("OPB")).not.toHaveAttribute("data-slot", "badge");
    expect(screen.getByText("frontend")).toHaveAttribute("data-slot", "badge");
  });

  test("a className recolours it, for a row marked current", () => {
    render(<KeyPill className="text-current">OPB</KeyPill>);
    const pill = screen.getByText("OPB");
    expect(pill).toHaveClass("text-current");
    expect(pill).not.toHaveClass("text-muted-foreground");
  });
});
