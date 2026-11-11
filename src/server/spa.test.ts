import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { setupTestApp } from "./test-app.js";

const INDEX_HTML = "<!doctype html><title>trail</title>";
const BUNDLE = "console.log('trail')";

const root = mkdtempSync(join(tmpdir(), "trail-spa-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const webDir = join(root, "web");
mkdirSync(join(webDir, "assets"), { recursive: true });
writeFileSync(join(webDir, "index.html"), INDEX_HTML);
writeFileSync(join(webDir, "assets", "index-abc123.js"), BUNDLE);
// beside the SPA directory, so only an escape reaches it
const SECRET = "not for the web";
writeFileSync(join(root, "secret.txt"), SECRET);
mkdirSync(join(root, "outside"));
writeFileSync(join(root, "outside", "secret.txt"), SECRET);
symlinkSync(join(root, "secret.txt"), join(webDir, "leak.txt"));
symlinkSync(join(root, "outside"), join(webDir, "linked"));
writeFileSync(join(webDir, ".env"), SECRET);
writeFileSync(join(webDir, "assets", ".hidden.js"), SECRET);

const { app } = setupTestApp({ webDir });

test("a hashed asset is served with its type and cached for good", async () => {
  const res = await app.request("/assets/index-abc123.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/javascript/);
  expect(res.headers.get("cache-control")).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(await res.text()).toBe(BUNDLE);
});

test("/ is index.html, revalidated on every load", async () => {
  const res = await app.request("/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(await res.text()).toBe(INDEX_HTML);
});

// what a browser sends on a navigation
const html = {
  headers: {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
};

test.each([
  "/projects/anything",
  "/issues/TRL-1",
  "/healthz",
  "/apidocs",
  "/mcp-setup",
  "/assets-guide",
])("a navigation to %s gets index.html for the SPA router", async (path) => {
  const res = await app.request(path, html);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(await res.text()).toBe(INDEX_HTML);
});

test.each(["*/*", "application/json", "application/json, text/html;q=0.5"])(
  "a miss with accept %s stays the JSON 404",
  async (accept) => {
    const res = await app.request("/projects/anything", {
      headers: { accept },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "no route GET /projects/anything" },
    });
  },
);

test.each(["/api/nope", "/api", "/api/", "/health/x"])(
  "%s stays the JSON 404 even for a navigation",
  async (path) => {
    const res = await app.request(path, html);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: `no route GET ${path}` },
    });
  },
);

test("/mcp/nope stays the bearer check's JSON 401 for a navigation", async () => {
  const res = await app.request("/mcp/nope", html);
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe("unauthorized");
});

test("/health and /api/web/me answer as without the SPA", async () => {
  const health = await app.request("/health", html);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  const me = await app.request("/api/web/me", html);
  expect(me.status).toBe(200);
  expect(((await me.json()) as { state: string }).state).toBe("anonymous");
});

test.each([
  "/%2e%2e/secret.txt",
  "/assets/%2e%2e/%2e%2e/secret.txt",
  "/..%2fsecret.txt",
  "/assets/..%2F..%2Fsecret.txt",
  "/assets/..%5c..%5csecret.txt",
  `/${encodeURIComponent(join(root, "secret.txt"))}`,
  `/${join(root, "secret.txt")}`,
  "/leak.txt",
  "/linked/secret.txt",
])("%s does not escape the SPA directory", async (path) => {
  const res = await app.request(`http://localhost${path}`);
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain(SECRET);
});

test.each(["*/*", html.headers.accept])(
  "a missing file under /assets is the JSON 404 with no cache header, for accept %s",
  async (accept) => {
    const res = await app.request("/assets/index-old999.js", {
      headers: { accept },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(await res.json()).toEqual({
      error: {
        code: "not_found",
        message: "no route GET /assets/index-old999.js",
      },
    });
  },
);

test.each(["/.env", "/assets/.hidden.js"])(
  "the dotfile %s is not served",
  async (path) => {
    for (const accept of ["*/*", html.headers.accept]) {
      const res = await app.request(path, { headers: { accept } });
      expect(await res.text()).not.toContain(SECRET);
    }
  },
);

test.each(["/assets/index-abc123.js", "/issues/TRL-1"])(
  "HEAD %s answers like GET with no body",
  async (path) => {
    const res = await app.request(path, { method: "HEAD", ...html });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeTruthy();
    expect(await res.text()).toBe("");
  },
);

test.each(["/", "/projects/anything"])(
  "the HTML at %s carries the security headers",
  async (path) => {
    const res = await app.request(path, html);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
  },
);

describe("with no SPA built", () => {
  const unbuilt = setupTestApp({ webDir: join(root, "never-built") });

  test.each(["/", "/projects/anything"])(
    "a navigation to %s is the JSON 404",
    async (path) => {
      const res = await unbuilt.app.request(path, html);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "not_found", message: `no route GET ${path}` },
      });
    },
  );
});
