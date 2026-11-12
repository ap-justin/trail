import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { __unstable__loadDesignSystem } from "@tailwindcss/node";
import { beforeAll, describe, expect, test } from "vitest";

// The half of the conformance gate the build can't enforce. The build half is in
// globals.css: `--color-*: initial` and friends leave an off-system class with no rule.
// This sweeps trail's own components and the app chrome; components/ui is the shadcn CLI's.

const stylesDir = resolve("src/web/styles");
const css = readFileSync(join(stylesDir, "globals.css"), "utf8");
const webDir = resolve("src/web");
const shadcnDir = resolve("src/web/components/ui");
const sweptDirs = [resolve("src/web/components"), resolve("src/web/app")];
const componentFiles = sweptDirs.flatMap((dir) => sourceFiles(dir));

/** Every non-test .ts/.tsx under `dir`, subdirectories included, minus components/ui. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return path === shadcnDir ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

/** Class-name tokens: every string literal, minus import paths and non-class JSX attributes. `className` and any `*ClassName` prop (`markClassName`) carry classes. */
function classTokens(source: string): string[] {
  const stripped = source
    .replace(/from\s+"[^"]*"/g, "")
    .replace(/\b(?![\w-]*[cC]lassName\b)[\w-]+="[^"]*"/g, "");
  const literals = stripped.match(/"[^"\n]*"|`[^`]*`/g) ?? [];
  return literals.flatMap((l) => l.slice(1, -1).split(/\s+/).filter(Boolean));
}

// an arbitrary value carrying its own length, duration or colour instead of a token
const literalValue =
  /\[[^\]]*(?:\d(?:px|rem|em|ms|s)\b|#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\()/i;

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
      "rounded-3xl",
      "shadow-sm",
    ]);
    expect(drawn).toEqual([null, null, null, null, null]);
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

  test("no transition: all", () => {
    expect(css).not.toMatch(/transition:\s*all|transition-all/);
    for (const file of componentFiles) {
      expect(readFileSync(file, "utf8"), file).not.toContain("transition-all");
    }
  });
});
