import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("index.html links the favicons", () => {
  const html = readFileSync("src/web/index.html", "utf8");
  expect(html).toContain(
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
  );
  expect(html).toContain(
    '<link rel="icon" href="/favicon.ico" sizes="48x48" />',
  );
  expect(html).toContain(
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  );
  for (const file of ["favicon.svg", "favicon.ico", "apple-touch-icon.png"]) {
    expect(existsSync(`src/web/public/${file}`)).toBe(true);
  }
});
