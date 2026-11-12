import { fireEvent, render, screen } from "@testing-library/react";
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

describe("ActorAvatar", () => {
  const sizes = [
    ["xs", "size-4.5"],
    ["sm", "size-6"],
    ["md", "size-7"],
    ["lg", "size-9"],
  ] as const;
  const photo = "/api/photos/a-kai/3f9a1c";

  test.each(sizes)(
    "%s: a photo sits over the initials in its kind's shape at its size",
    (size, sizeClass) => {
      const { container } = render(
        <>
          <ActorAvatar
            actor={{ name: "Kai", kind: "bot", photoUrl: photo }}
            size={size}
          />
          <ActorAvatar
            actor={{
              name: "Maya Chen",
              kind: "human",
              photoUrl: "/api/photos/a-maya/77b2",
            }}
            size={size}
          />
        </>,
      );
      const [bot, human] = container.children;
      expect(bot).toHaveClass(sizeClass, "rounded-md", "bg-bot-muted");
      expect(bot?.querySelector("img")).toHaveAttribute("src", photo);
      expect(bot).toHaveTextContent("K");
      expect(human).toHaveClass(sizeClass, "rounded-full");
      expect(human?.querySelector("img")).toHaveAttribute(
        "src",
        "/api/photos/a-maya/77b2",
      );
      expect(human).toHaveTextContent("MC");
    },
  );

  test.each(sizes)(
    "%s: a bot's photo is framed in indigo inside its box; a person's is a bare circle",
    (size, sizeClass) => {
      const { container } = render(
        <>
          <ActorAvatar
            actor={{ name: "Kai", kind: "bot", photoUrl: photo }}
            size={size}
          />
          <ActorAvatar
            actor={{ name: "Maya Chen", kind: "human", photoUrl: photo }}
            size={size}
          />
        </>,
      );
      const [bot, human] = container.children;
      expect(bot).toHaveClass(sizeClass, "rounded-md", "border", "border-bot");
      expect(human).toHaveClass(sizeClass, "rounded-full");
      expect(human).not.toHaveClass("border");
      expect(human?.className).not.toMatch(/\bborder-/);
    },
  );

  test("a bot without a photo, or whose photo failed, has no frame", () => {
    const { container } = render(
      <>
        <ActorAvatar actor={{ name: "Kai", kind: "bot", photoUrl: null }} />
        <ActorAvatar actor={{ name: "Kai", kind: "bot", photoUrl: photo }} />
      </>,
    );
    const [bare, failing] = container.children;
    expect(bare).not.toHaveClass("border");
    expect(bare).not.toHaveClass("border-bot");
    const img = failing?.querySelector("img");
    if (!img) throw new Error("no img");
    fireEvent.error(img);
    expect(failing).not.toHaveClass("border");
    expect(failing).not.toHaveClass("border-bot");
    expect(failing).toHaveClass("bg-bot-muted", "text-bot");
  });

  test("the photo is decorative and loads lazily", () => {
    const { container } = render(
      <ActorAvatar actor={{ name: "Kai", kind: "bot", photoUrl: photo }} />,
    );
    const img = container.querySelector("img");
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
  });

  test("loading is lazy by default and eager on request", () => {
    const { container } = render(
      <>
        <ActorAvatar actor={{ name: "Kai", kind: "bot", photoUrl: photo }} />
        <ActorAvatar
          actor={{ name: "Kai", kind: "bot", photoUrl: photo }}
          loading="eager"
        />
      </>,
    );
    const [lazy, eager] = container.querySelectorAll("img");
    expect(lazy).toHaveAttribute("loading", "lazy");
    expect(eager).toHaveAttribute("loading", "eager");
  });

  test.each([null, undefined])(
    "photoUrl %s: initials and no img",
    (photoUrl) => {
      const { container } = render(
        <>
          <ActorAvatar actor={{ name: "Kai", kind: "bot", photoUrl }} />
          <ActorAvatar actor={{ name: "Maya Chen", kind: "human", photoUrl }} />
        </>,
      );
      const [bot, human] = container.children;
      expect(bot).toHaveTextContent("K");
      expect(human).toHaveTextContent("MC");
      expect(container.querySelector("img")).toBeNull();
    },
  );

  test("a photo that fails to load falls back to initials; a new photo gets its own try", () => {
    const { container, rerender } = render(
      <ActorAvatar
        actor={{ name: "Maya Chen", kind: "human", photoUrl: photo }}
      />,
    );
    expect(container.firstElementChild).toHaveTextContent("MC");
    const img = container.querySelector("img");
    if (!img) throw new Error("no img");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.firstElementChild).toHaveTextContent("MC");

    rerender(
      <ActorAvatar
        actor={{
          name: "Maya Chen",
          kind: "human",
          photoUrl: "/api/photos/a-maya/77b2",
        }}
      />,
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/api/photos/a-maya/77b2",
    );
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
