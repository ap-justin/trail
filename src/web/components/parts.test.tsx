import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ActorAvatar, ActorBadge } from "@/components/actor";
import { NotFoundPanel } from "@/components/states";
import { PriorityLabel } from "@/components/status";
import { photoUrlFor } from "@/test/fixtures";

describe("ActorBadge", () => {
  test.each([
    ["bot", "Bot"],
    ["human", "Human"],
  ] as const)("%s: the kind as screen-reader text, no pill", (kind, word) => {
    const { container } = render(<ActorBadge kind={kind} />);
    const badge = container.firstElementChild;
    expect(badge).toHaveTextContent(word);
    expect(badge).toHaveClass("sr-only");
    expect(badge?.querySelector("svg")).toBeNull();
  });
});

describe("avatar shape and name", () => {
  test("each avatar is an image named for the actor and their kind", () => {
    render(
      <>
        <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: null }} />
        <ActorAvatar
          actor={{ name: "Olive Owner", kind: "human", photoUrl: null }}
        />
      </>,
    );
    expect(screen.getByRole("img", { name: "Alpha, bot" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Olive Owner, person" }),
    ).toBeInTheDocument();
  });

  test("bot avatars are teal rounded squares, human avatars grey circles", () => {
    const { container } = render(
      <>
        <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: null }} />
        <ActorAvatar
          actor={{ name: "Maya Chen", kind: "human", photoUrl: null }}
        />
      </>,
    );
    const [bot, human] = container.children;
    expect(bot).toHaveTextContent("A");
    expect(bot).toHaveClass("rounded-md", "bg-bot-muted", "text-bot");
    expect(human).toHaveTextContent("MC");
    expect(human).toHaveClass("rounded-full", "bg-muted");
  });
});

describe("ActorAvatar", () => {
  const sizes = [
    ["xs", "size-4.5"],
    ["sm", "size-6"],
    ["md", "size-7"],
    ["lg", "size-9"],
  ] as const;
  const photo = photoUrlFor("a-alpha", "3f");

  test.each(sizes)(
    "%s: a photo sits over the initials in its kind's shape at its size",
    (size, sizeClass) => {
      const { container } = render(
        <>
          <ActorAvatar
            actor={{ name: "Alpha", kind: "bot", photoUrl: photo }}
            size={size}
          />
          <ActorAvatar
            actor={{
              name: "Maya Chen",
              kind: "human",
              photoUrl: photoUrlFor("a-maya", "77"),
            }}
            size={size}
          />
        </>,
      );
      const [bot, human] = container.children;
      expect(bot).toHaveClass(sizeClass, "rounded-md", "bg-bot-muted");
      expect(bot?.querySelector("img")).toHaveAttribute("src", photo);
      expect(bot).toHaveTextContent("A");
      expect(human).toHaveClass(sizeClass, "rounded-full");
      expect(human?.querySelector("img")).toHaveAttribute(
        "src",
        photoUrlFor("a-maya", "77"),
      );
      expect(human).toHaveTextContent("MC");
    },
  );

  test.each(sizes)(
    "%s: a bot's photo wears the teal border and rounded-md classes; a person's has the round class and no border",
    (size, sizeClass) => {
      const { container } = render(
        <>
          <ActorAvatar
            actor={{ name: "Alpha", kind: "bot", photoUrl: photo }}
            size={size}
          />
          <ActorAvatar
            actor={{ name: "Maya Chen", kind: "human", photoUrl: photo }}
            size={size}
          />
        </>,
      );
      const [bot, human] = container.children;
      for (const img of container.querySelectorAll("img")) fireEvent.load(img);
      expect(bot).toHaveClass(sizeClass, "rounded-md", "border", "border-bot");
      expect(human).toHaveClass(sizeClass, "rounded-full");
      expect(human).not.toHaveClass("border");
      expect(human?.className).not.toMatch(/\bborder-/);
    },
  );

  test("a bot without a photo has no frame; one whose loaded photo then fails drops the img and the frame", () => {
    const { container } = render(
      <>
        <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: null }} />
        <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: photo }} />
      </>,
    );
    const [bare, failing] = container.children;
    expect(bare).not.toHaveClass("border");
    expect(bare).not.toHaveClass("border-bot");
    const img = failing?.querySelector("img");
    if (!img) throw new Error("no img");
    // framed first, so only the error handler can take the frame away
    fireEvent.load(img);
    expect(failing).toHaveClass("border", "border-bot");
    fireEvent.error(img);
    expect(failing?.querySelector("img")).toBeNull();
    expect(failing).not.toHaveClass("border");
    expect(failing).not.toHaveClass("border-bot");
    expect(failing).toHaveClass("bg-bot-muted", "text-bot");
    expect(failing).toHaveTextContent("A");
  });

  test("a bot's frame shows only while its photo is shown: not while loading, not after a failure", () => {
    const { container, rerender } = render(
      <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: photo }} />,
    );
    const avatar = container.firstElementChild;
    const img = container.querySelector("img");
    if (!img) throw new Error("no img");
    expect(avatar).not.toHaveClass("border");
    expect(avatar).not.toHaveClass("border-bot");
    expect(avatar).toHaveClass("bg-bot-muted", "text-bot");
    expect(avatar).toHaveTextContent("A");

    fireEvent.load(img);
    expect(avatar).toHaveClass("border", "border-bot");

    rerender(
      <ActorAvatar
        actor={{
          name: "Alpha",
          kind: "bot",
          photoUrl: photoUrlFor("a-new", "9c"),
        }}
      />,
    );
    expect(avatar).not.toHaveClass("border");
    expect(avatar).not.toHaveClass("border-bot");
    const next = container.querySelector("img");
    if (!next) throw new Error("no img");
    fireEvent.load(next);
    expect(avatar).toHaveClass("border", "border-bot");

    fireEvent.error(next);
    expect(avatar).not.toHaveClass("border");
    expect(avatar).not.toHaveClass("border-bot");
  });

  test("a new photo URL gets a fresh img, so the old photo never paints unframed under the initials", () => {
    const { container, rerender } = render(
      <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: photo }} />,
    );
    const avatar = container.firstElementChild;
    const old = container.querySelector("img");
    if (!old) throw new Error("no img");
    fireEvent.load(old);
    expect(avatar).toHaveClass("border", "border-bot");

    rerender(
      <ActorAvatar
        actor={{
          name: "Alpha",
          kind: "bot",
          photoUrl: "/api/photos/a-new/9c0d",
        }}
      />,
    );
    const next = container.querySelector("img");
    expect(old).not.toBeInTheDocument();
    expect(next).not.toBe(old);
    expect(next).toHaveAttribute("src", "/api/photos/a-new/9c0d");
    expect(avatar).toHaveTextContent("A");
    expect(avatar).not.toHaveClass("border");
  });

  test("the photo is decorative inside the named avatar, and loads lazily", () => {
    const { container } = render(
      <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: photo }} />,
    );
    const img = container.querySelector("img");
    expect(container.firstElementChild).toHaveAccessibleName("Alpha, bot");
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("loading", "lazy");
    // async decoding can fire load before the pixels are ready, leaving a blank frame
    expect(img).not.toHaveAttribute("decoding");
  });

  test("loading is lazy by default and eager on request", () => {
    const { container } = render(
      <>
        <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: photo }} />
        <ActorAvatar
          actor={{ name: "Alpha", kind: "bot", photoUrl: photo }}
          loading="eager"
        />
      </>,
    );
    const [lazy, eager] = container.querySelectorAll("img");
    expect(lazy).toHaveAttribute("loading", "lazy");
    expect(eager).toHaveAttribute("loading", "eager");
  });

  test("photoUrl null: initials and no img", () => {
    const { container } = render(
      <>
        <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: null }} />
        <ActorAvatar
          actor={{ name: "Maya Chen", kind: "human", photoUrl: null }}
        />
      </>,
    );
    const [bot, human] = container.children;
    expect(bot).toHaveTextContent("A");
    expect(human).toHaveTextContent("MC");
    expect(container.querySelector("img")).toBeNull();
  });

  test.each([
    ["bot", "Alpha", "A"],
    ["human", "Maya Chen", "MC"],
  ] as const)(
    "%s: initials show until the photo loads, then stop painting so a transparent photo never shows them through",
    (kind, name, letters) => {
      const { container, rerender } = render(
        <ActorAvatar actor={{ name, kind, photoUrl: photo }} />,
      );
      const avatar = container.firstElementChild;
      expect(avatar).toHaveTextContent(letters);
      const img = container.querySelector("img");
      if (!img) throw new Error("no img");
      fireEvent.load(img);
      expect(avatar).not.toHaveTextContent(letters);
      expect(img).toBeInTheDocument();
      if (kind === "bot") expect(avatar).toHaveClass("border", "border-bot");

      rerender(
        <ActorAvatar
          actor={{ name, kind, photoUrl: photoUrlFor("a-new", "9c") }}
        />,
      );
      expect(avatar).toHaveTextContent(letters);
    },
  );

  test.each([
    ["bot", "Alpha", "A"],
    ["human", "Maya Chen", "MC"],
  ] as const)(
    "%s: the img loads hidden behind the initials, unframed, and shows only once loaded",
    (kind, name, letters) => {
      const { container } = render(
        <>
          <ActorAvatar actor={{ name, kind, photoUrl: photo }} />
          <ActorAvatar actor={{ name, kind, photoUrl: photo }} />
        </>,
      );
      const [loading, failing] = container.children;
      const img = loading?.querySelector("img");
      if (!img) throw new Error("no img");
      // a partly decoded photo would otherwise paint over the initials
      expect(img).toHaveClass("opacity-0");
      expect(loading).toHaveTextContent(letters);
      expect(loading).not.toHaveClass("border");

      fireEvent.load(img);
      expect(img).not.toHaveClass("opacity-0");
      expect(loading).not.toHaveTextContent(letters);
      if (kind === "bot") expect(loading).toHaveClass("border", "border-bot");

      const broken = failing?.querySelector("img");
      if (!broken) throw new Error("no img");
      fireEvent.error(broken);
      expect(failing?.querySelector("img")).toBeNull();
      expect(failing).toHaveTextContent(letters);
      expect(failing).not.toHaveClass("border");
    },
  );

  describe("an image already complete when it attaches (the browser had it cached)", () => {
    // jsdom never decodes, so its img is never complete; stand in for a cached photo
    function stubCompleteImages() {
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
        true,
      );
      vi.spyOn(
        HTMLImageElement.prototype,
        "naturalWidth",
        "get",
      ).mockReturnValue(64);
    }
    afterEach(() => vi.restoreAllMocks());

    test.each([
      ["bot", "Alpha", "A"],
      ["human", "Maya Chen", "MC"],
    ] as const)(
      "%s: no initials from the first paint, without waiting for load",
      (kind, name, letters) => {
        stubCompleteImages();
        const { container } = render(
          <ActorAvatar actor={{ name, kind, photoUrl: photo }} />,
        );
        const avatar = container.firstElementChild;
        expect(avatar).not.toHaveTextContent(letters);
        expect(container.querySelector("img")).toHaveAttribute("src", photo);
        if (kind === "bot") expect(avatar).toHaveClass("border", "border-bot");
        else expect(avatar).not.toHaveClass("border");
      },
    );

    test("a cached new URL is shown straight away too", () => {
      const { container, rerender } = render(
        <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: photo }} />,
      );
      expect(container.firstElementChild).toHaveTextContent("A");
      stubCompleteImages();
      rerender(
        <ActorAvatar
          actor={{
            name: "Alpha",
            kind: "bot",
            photoUrl: photoUrlFor("a-new", "9c"),
          }}
        />,
      );
      expect(container.firstElementChild).not.toHaveTextContent("A");
    });

    test("a new URL still fetching keeps the initials until it loads", () => {
      stubCompleteImages();
      const { container, rerender } = render(
        <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: photo }} />,
      );
      const avatar = container.firstElementChild;
      const old = container.querySelector("img");
      expect(avatar).not.toHaveTextContent("A");
      // the new URL's fresh img isn't complete yet
      vi.restoreAllMocks();
      rerender(
        <ActorAvatar
          actor={{
            name: "Alpha",
            kind: "bot",
            photoUrl: photoUrlFor("a-new", "9c"),
          }}
        />,
      );
      const img = container.querySelector("img");
      if (!img) throw new Error("no img");
      expect(img).not.toBe(old);
      expect(avatar).toHaveTextContent("A");
      expect(avatar).not.toHaveClass("border");
      fireEvent.load(img);
      expect(avatar).not.toHaveTextContent("A");
    });

    test("a complete image that decoded to nothing (broken) keeps the initials", () => {
      // complete, but naturalWidth stays jsdom's 0: only the naturalWidth guard rejects it
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
        true,
      );
      const { container } = render(
        <ActorAvatar actor={{ name: "Alpha", kind: "bot", photoUrl: photo }} />,
      );
      expect(container.firstElementChild).toHaveTextContent("A");
    });
  });

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
          photoUrl: photoUrlFor("a-maya", "77"),
        }}
      />,
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      photoUrlFor("a-maya", "77"),
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
