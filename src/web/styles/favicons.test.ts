import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const publicDir = "src/web/public";
const html = readFileSync("src/web/index.html", "utf8");

type IconLink = { rel: string; href: string; sizes?: string };

const iconLinks: IconLink[] = [...html.matchAll(/<link\s[^>]*>/g)]
  .map(([tag]) => ({
    rel: /\brel="([^"]*)"/.exec(tag)?.[1] ?? "",
    href: /\bhref="([^"]*)"/.exec(tag)?.[1] ?? "",
    sizes: /\bsizes="([^"]*)"/.exec(tag)?.[1],
  }))
  .filter((l) => l.rel === "icon" || l.rel === "apple-touch-icon");

const linked = (rel: string, ext: string) =>
  iconLinks.find((l) => l.rel === rel && l.href.endsWith(ext));

const bytesOf = (href: string) => readFileSync(join(publicDir, href));

describe("index.html icon links", () => {
  test("declares the svg, ico and apple-touch icons", () => {
    expect(linked("icon", ".svg")).toBeDefined();
    expect(linked("icon", ".ico")).toBeDefined();
    expect(linked("apple-touch-icon", ".png")).toBeDefined();
  });

  test("every href resolves to a file under public", () => {
    for (const { href } of iconLinks) {
      expect(href.startsWith("/"), href).toBe(true);
      expect(existsSync(join(publicDir, href)), href).toBe(true);
    }
  });

  test("the svg is an svg document", () => {
    const svg = bytesOf(linked("icon", ".svg")?.href ?? "").toString("utf8");
    expect(svg).toMatch(/<svg[\s>]/);
  });

  test("apple-touch-icon is a 180x180 PNG", () => {
    const png = bytesOf(linked("apple-touch-icon", ".png")?.href ?? "");
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    // IHDR: width and height are the first two big-endian uint32s of the chunk data
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  });

  test("the ico holds a frame of the size index.html declares", () => {
    const link = linked("icon", ".ico");
    const declared = /^(\d+)x\1$/.exec(link?.sizes ?? "")?.[1];
    expect(declared, "ico link declares a square sizes").toBeDefined();

    const ico = bytesOf(link?.href ?? "");
    // ICONDIR: reserved 0, type 1 (icon), frame count; 16-byte entries follow, width at byte 0 (0 means 256)
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const frames = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
      const width = ico.readUInt8(6 + i * 16);
      return width === 0 ? 256 : width;
    });
    expect(frames).toContain(Number(declared));
  });
});
