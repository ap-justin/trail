import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compile, optimize } from "@tailwindcss/node";

const stylesDir = resolve("src/web/styles");

/**
 * Compiles globals.css for every class under `root` and puts it in the document, so
 * `getComputedStyle` answers what the browser would. Returns the remover.
 */
export async function applyCompiledCss(root: Element): Promise<() => void> {
  const candidates = [root, ...root.querySelectorAll("[class]")].flatMap((el) =>
    [...el.classList].map(String),
  );
  const css = readFileSync(join(stylesDir, "globals.css"), "utf8");
  const compiler = await compile(css, { base: stylesDir, onDependency() {} });
  const style = document.createElement("style");
  style.textContent = optimize(compiler.build(candidates)).code;
  document.head.append(style);
  return () => style.remove();
}
