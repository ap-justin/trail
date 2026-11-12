import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, MiddlewareHandler } from "hono";
import { accepts } from "hono/accepts";
import { secureHeaders } from "hono/secure-headers";

/** Every regular file under `dir` by its URL path; symlinks and dotfiles are left out. */
function listFiles(dir: string, urlPrefix = ""): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    const url = `${urlPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [u, p] of listFiles(path, url)) files.set(u, p);
    } else if (entry.isFile()) {
      files.set(url, path);
    }
  }
  return files;
}

/**
 * A browser loading a page outside /api, /mcp, /health and /assets: `accept` ranks
 * text/html above JSON. A bare `*\/*` (curl, most HTTP clients) is not one, so
 * a bot's miss stays the JSON 404. So does a missing asset: index.html under
 * its URL would be cached as that asset for good.
 */
const isNavigation = (c: Context) =>
  !/^\/(api|mcp|health|assets)(\/|$)/.test(c.req.path) &&
  accepts(c, {
    header: "Accept",
    supports: ["text/html", "application/json"],
    default: "application/json",
  }) === "text/html";

const immutable = "public, max-age=31536000, immutable";

// one same-origin bundle with no CDN or inline script; inline styles stay allowed
// for UI libraries that set style attributes or inject <style>
const securityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    fontSrc: ["'self'"],
    imgSrc: ["'self'"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
  referrerPolicy: "same-origin",
  xFrameOptions: "DENY",
});

/**
 * GET handlers serving the built SPA in `dir`, or none while it holds no
 * index.html (not built yet). Only files listed here, at startup, are reachable,
 * so no request path can name anything outside it.
 */
export function spaHandlers(
  dir: string,
): [MiddlewareHandler, MiddlewareHandler, MiddlewareHandler] | undefined {
  if (!existsSync(dir)) return undefined;
  const files = listFiles(dir);
  const index = files.get("/index.html");
  if (index === undefined) return undefined;
  files.set("/", index);
  const fileFor = (c: Context) =>
    files.get(c.req.path) ?? (isNavigation(c) ? index : undefined);
  return [
    // a miss is the app's JSON 404, without the page's headers
    async (c, next) => (fileFor(c) === undefined ? c.notFound() : next()),
    securityHeaders,
    async (c, next) => {
      c.header(
        "cache-control",
        c.req.path.startsWith("/assets/") ? immutable : "no-cache",
      );
      const res = await serveStatic({ path: fileFor(c) })(c, next);
      return res ?? c.notFound();
    },
  ];
}
