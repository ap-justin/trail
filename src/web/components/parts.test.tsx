import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ActorAvatar, ActorBadge } from "@/components/actor";
import { NotFoundPanel } from "@/components/states";
import { PriorityLabel } from "@/components/status";

describe("ActorBadge", () => {
  test.each([
    ["bot", "Bot", "lucide-bot"],
    ["human", "Human", "lucide-user"],
  ] as const)(
    "%s: a text label and its glyph, never colour alone",
    (kind, word, glyph) => {
      const { container } = render(<ActorBadge kind={kind} />);
      const badge = container.firstElementChild;
      expect(badge).toHaveTextContent(word);
      expect(badge?.querySelector(`svg.${glyph}`)).not.toBeNull();
    },
  );

  test("bot avatars are rounded squares, human avatars circles", () => {
    const { container } = render(
      <>
        <ActorAvatar actor={{ name: "Kai", kind: "bot" }} />
        <ActorAvatar actor={{ name: "Maya Chen", kind: "human" }} />
      </>,
    );
    const [bot, human] = container.children;
    expect(bot).toHaveTextContent("K");
    expect(bot).toHaveClass("rounded-md");
    expect(human).toHaveTextContent("MC");
    expect(human).toHaveClass("rounded-full");
  });
});

describe("PriorityLabel", () => {
  test.each([
    [1, "Urgent"],
    [2, "High"],
    [3, "Medium"],
    [4, "Low"],
    [0, "None"],
  ])("icon-only priority %i is named %s", (priority, name) => {
    render(<PriorityLabel priority={priority} iconOnly />);
    expect(screen.getByRole("img", { name })).toBeInTheDocument();
  });

  test("with the word, the glyph is decorative", () => {
    const { container } = render(<PriorityLabel priority={2} />);
    expect(container).toHaveTextContent("High");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test("0 renders None with a dash and no signal glyph", () => {
    const { container } = render(<PriorityLabel priority={0} />);
    expect(container).toHaveTextContent("None");
    expect(container.querySelector("svg.lucide-minus")).not.toBeNull();
    expect(container.querySelector("svg[class*='lucide-signal']")).toBeNull();
  });
});

describe("NotFoundPanel", () => {
  test("the spec's copy, with a way back to the feed", () => {
    render(<NotFoundPanel />);
    expect(
      screen.getByRole("heading", { name: "Page not found" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This page doesn't exist, or you don't have access to it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to feed" })).toHaveAttribute(
      "href",
      "/",
    );
  });
});
