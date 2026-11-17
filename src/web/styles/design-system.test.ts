import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  __unstable__loadDesignSystem,
  compile,
  optimize,
} from "@tailwindcss/node";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, test } from "vitest";

// The half of the conformance gate the build can't enforce. The build half is in
// globals.css: `--color-*: initial` and friends leave an off-system class with no rule.
// This sweeps trail's components, the restyled primitives in components/ui, and the app chrome.

const stylesDir = resolve("src/web/styles");
const css = readFileSync(join(stylesDir, "globals.css"), "utf8");
const webDir = resolve("src/web");
const sweptDirs = [resolve("src/web/components"), resolve("src/web/app")];
const componentFiles = sweptDirs.flatMap((dir) => sourceFiles(dir));

/** Every non-test .ts/.tsx under `dir`, subdirectories included. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

/** Class strings: every string literal, minus import paths and non-class JSX attributes. `className` and any `*ClassName` prop (`markClassName`) carry classes. */
function classStrings(source: string): string[] {
  const stripped = source
    .replace(/from\s+"[^"]*"/g, "")
    .replace(/\b(?![\w-]*[cC]lassName\b)[\w-]+="[^"]*"/g, "");
  const literals = stripped.match(/"[^"\n]*"|`[^`]*`/g) ?? [];
  return literals.map((l) => l.slice(1, -1));
}

/** Class-name tokens: each class string split on whitespace. */
function classTokens(source: string): string[] {
  return classStrings(source).flatMap((l) => l.split(/\s+/).filter(Boolean));
}

// an arbitrary value carrying its own length, duration or colour instead of a token
const literalValue =
  /\[[^\]]*(?:\d(?:px|rem|em|ms|s)\b|#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\()/i;

// a percentage stop: a mask fade (`mask-r-from-88%`) or a colour-mix share (`_5%`) invents a
// value the token file doesn't name. Percentages that are a size (`w-[50%]`, `calc(100%-…)`)
// are layout, not a design value, so only a stop or a mix share counts.
const percentStop =
  /(?:^|:)-?mask-[\w-]*-(?:from|to)-\d+(?:\.\d+)?%|\[[^\]]*_\d+(?:\.\d+)?%/;

// Named gaps, each pending a design decision; anything not listed here fails the sweep.
const allowedPercentStops: Finding[] = [
  // the status tabs' fade edge: an 88% stop the tokens don't name
  { file: "components/item-list.tsx", token: "max-lg:mask-r-from-88%" },
  // the secondary button's hover step: a 5% mix the tokens don't name (no caller yet)
  {
    file: "components/ui/button.tsx",
    token:
      "hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
  },
];

type Finding = { file: string; token: string };

let designSystem: Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;
beforeAll(async () => {
  designSystem = await __unstable__loadDesignSystem(css, { base: stylesDir });
});

function sweep(check: (token: string) => boolean): Finding[] {
  return componentFiles.flatMap((file) =>
    [...new Set(classTokens(readFileSync(file, "utf8")))]
      .filter(check)
      .map((token) => ({ file: file.slice(webDir.length + 1), token })),
  );
}

describe("components and app chrome stay inside the design system", () => {
  test("no literal values: every colour, length and duration is a token", () => {
    expect(sweep((token) => literalValue.test(token))).toEqual([]);
  });

  test("no percentage stops: a mask fade or colour-mix share is a token too", () => {
    const unallowed = sweep((token) => percentStop.test(token)).filter(
      (found) =>
        !allowedPercentStops.some(
          (ok) => ok.file === found.file && ok.token === found.token,
        ),
    );
    expect(unallowed).toEqual([]);
  });

  test("no class names the stylesheet doesn't draw", () => {
    // a token Tailwind reads as a utility but compiles to nothing paints nothing, silently
    // hyphenless words ("to", "start") are mostly copy; the bare utilities among them exist
    const findings = sweep(
      (token) =>
        /[-:]/.test(token) &&
        designSystem.parseCandidate(token).length > 0 &&
        designSystem.candidatesToCss([token])[0] === null,
    );
    expect(findings).toEqual([]);
  });

  test("the stock palette and scales are closed", () => {
    const drawn = designSystem.candidatesToCss([
      "text-gray-500",
      "bg-red-600",
      "text-2xl",
      "rounded-xs",
      "shadow-sm",
    ]);
    expect(drawn).toEqual([null, null, null, null, null]);
  });

  test("the frame, the row rule and the sheet's corner are tokens", () => {
    const [frame, rule, sheet] = designSystem.candidatesToCss([
      "bg-frame",
      "border-rule",
      "rounded-3xl",
    ]);
    expect(frame).toContain("var(--frame)");
    expect(rule).toContain("var(--rule)");
    expect(sheet).toContain("var(--radius-3xl)");
    expect(css).toMatch(/--radius-3xl:\s*16px/);
  });

  test("every figure is tabular", () => {
    expect(css).toMatch(/body\s*{[^}]*tabular-nums/);
  });
});

describe("focus and disabled", () => {
  // focus is a 2px outline in --ring, offset 2px (inset in rows and menus), never a ring-* shadow
  test("no focus style is drawn with a ring", () => {
    expect(
      sweep((token) =>
        /^(?:[\w-]+:)*focus(?:-visible)?:(?:[\w-]+:)*ring(?:-|$)/.test(token),
      ),
    ).toEqual([]);
  });

  test("a focus outline is the 2px one in --ring", () => {
    expect(
      sweep(
        (token) =>
          /^(?:[\w-]+:)*focus(?:-visible)?:(?:[\w-]+:)*-?outline(?:-|$)/.test(
            token,
          ) && !/:(?:outline-2|-?outline-offset-2|outline-ring)$/.test(token),
      ),
    ).toEqual([]);
  });

  // `outline-none` and `outline-hidden` set `--tw-outline-style: none`, which `focus-visible:outline-2` reads
  test("no class string pairs a suppressed outline with a focus outline", () => {
    const findings = componentFiles.flatMap((file) =>
      classStrings(readFileSync(file, "utf8"))
        .filter(
          (classes) =>
            /(?:^|\s)outline-(?:none|hidden)(?:\s|$)/.test(classes) &&
            /(?:^|\s)(?:[\w-]+:)*focus-visible:-?outline-/.test(classes),
        )
        .map((classes) => ({ file: file.slice(webDir.length + 1), classes })),
    );
    expect(findings).toEqual([]);
  });

  test("every class string with a focus outline draws it when Tab lands there", async () => {
    const outlined = componentFiles.flatMap((file) =>
      classStrings(readFileSync(file, "utf8"))
        .filter((classes) =>
          /(?:^|\s)focus-visible:outline-2(?:\s|$)/.test(classes),
        )
        .map((classes) => ({
          file: file.slice(webDir.length + 1),
          classes: classes.trim(),
        })),
    );
    expect(outlined.length).toBeGreaterThan(10);

    const compiler = await compile(css, { base: stylesDir, onDependency() {} });
    const candidates = outlined.flatMap(({ classes }) => classes.split(/\s+/));
    const style = document.createElement("style");
    style.textContent = optimize(compiler.build(candidates)).code;
    document.head.append(style);

    const user = userEvent.setup();
    const undrawn = [];
    for (const { file, classes } of outlined) {
      document.body.replaceChildren();
      const target = document.createElement("a");
      target.href = "#";
      target.setAttribute("class", classes);
      document.body.append(target);
      await user.tab();
      const { outlineStyle, outlineWidth } = getComputedStyle(target);
      if (
        document.activeElement !== target ||
        outlineStyle === "none" ||
        outlineWidth !== "2px"
      ) {
        undrawn.push({ file, classes, outlineStyle, outlineWidth });
      }
    }
    style.remove();
    expect(undrawn).toEqual([]);
  });

  // a disabled control stays legible: muted ground and ink, never faded
  test("nothing disabled fades", () => {
    expect(
      sweep((token) =>
        /disabled[^:]*:(?:[\w-]+:)*opacity-(?!100$)/.test(token),
      ),
    ).toEqual([]);
  });
});

describe("the class collector", () => {
  test("reads classes passed through any *ClassName prop, not other attributes", () => {
    const tokens = classTokens(
      '<Logo className="a-1" markClassName="h-[18px]" wordmarkClassName="w-[2rem]" href="x-y" />',
    );
    expect(tokens).toEqual(["a-1", "h-[18px]", "w-[2rem]"]);
    expect(tokens.filter((t) => literalValue.test(t))).toEqual([
      "h-[18px]",
      "w-[2rem]",
    ]);
  });
});

describe("the percentage-stop matcher", () => {
  test("catches mask stops and colour-mix shares, not layout percentages", () => {
    const hit = [
      "max-lg:mask-r-from-88%",
      "mask-b-to-90%",
      "hover:bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)]",
    ];
    const miss = ["w-[50%]", "h-[calc(100%-2rem)]", "w-1/2", "mask-r-from-4"];
    expect(hit.filter((t) => percentStop.test(t))).toEqual(hit);
    expect(miss.filter((t) => percentStop.test(t))).toEqual([]);
  });
});

describe("motion", () => {
  /** Each `@media (prefers-reduced-motion: reduce)` body, plus the keyframes it names. */
  function reducedMotionCss(): string {
    const bodies: string[] = [];
    const marker = "@media (prefers-reduced-motion: reduce)";
    for (
      let at = css.indexOf(marker);
      at !== -1;
      at = css.indexOf(marker, at + 1)
    ) {
      const open = css.indexOf("{", at);
      let depth = 0;
      let end = open;
      for (; end < css.length; end++) {
        if (css[end] === "{") depth++;
        else if (css[end] === "}" && --depth === 0) break;
      }
      bodies.push(css.slice(open + 1, end));
    }
    const named =
      bodies.join("\n").match(/[a-z-]+(?=\s+var\(--duration)/g) ?? [];
    const keyframes = named.map((name) => {
      const start = css.indexOf(`@keyframes ${name} `);
      return start === -1 ? "" : css.slice(start, css.indexOf("\n}", start));
    });
    return [...bodies, ...keyframes].join("\n");
  }

  test("reduced motion moves nothing: no translate or transform", () => {
    const reduced = reducedMotionCss();
    expect(reduced).toContain("row-enter-reduced");
    expect(reduced).not.toMatch(/translate|transform/);
  });

  test("a bare colour or opacity transition runs on --duration-fast, 150ms", () => {
    expect(css).toMatch(/--duration-fast:\s*150ms;/);
    expect(css).toMatch(
      /--default-transition-duration:\s*var\(--duration-fast\);/,
    );
    expect(
      designSystem.candidatesToCss(["duration-(--duration-fast)"])[0],
    ).toContain("var(--duration-fast)");
  });

  test("no transition: all", () => {
    expect(css).not.toMatch(/transition:\s*all|transition-all/);
    for (const file of componentFiles) {
      expect(readFileSync(file, "utf8"), file).not.toContain("transition-all");
    }
  });
});
