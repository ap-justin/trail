import type { setupTestApp } from "../test-app.js";

type Request = ReturnType<typeof setupTestApp>["request"];

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
export type Body = any;

/** Writes through /api/v1 as a bot, and reads /api/web as a person, for the web tests. */
export function webSeed(request: Request) {
  async function ok(res: Response, what: string): Promise<Body> {
    if (res.status >= 300) {
      throw new Error(`${what} gave ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  /** GET /api/web{path} with the session cookie. */
  async function get(path: string, cookie: string) {
    const res = await request("GET", `/api/web${path}`, { key: null, cookie });
    return { status: res.status, body: (await res.json()) as Body };
  }

  /** An item filed by the bot (`key`, by default the test bot), then moved to `status` when given; returns its key. */
  async function item(
    product: string,
    type: "issue" | "todo" | "note",
    {
      status,
      key,
      ...extra
    }: { status?: string; key?: string } & Record<string, unknown> = {},
  ): Promise<string> {
    const created = await ok(
      await request("POST", "/api/v1/items", {
        json: { type, product, title: `${type} ${product}`, ...extra },
        key,
      }),
      "item create",
    );
    if (status !== undefined && status !== created.status) {
      await ok(
        await request("PATCH", `/api/v1/items/${created.key}`, {
          json: { status },
          key,
        }),
        "item status",
      );
    }
    return created.key;
  }

  /** A project drawing from these product keys, holding these item keys; returns its slug. */
  async function project(
    name: string,
    products: string[],
    items: string[] = [],
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const { slug } = await ok(
      await request("POST", "/api/v1/projects", {
        json: { name, products, ...extra },
      }),
      "project create",
    );
    if (items.length > 0) {
      await ok(
        await request("POST", `/api/v1/projects/${slug}/items`, {
          json: { items },
        }),
        "project add",
      );
    }
    return slug;
  }

  async function statusUpdate(
    target: { product: string } | { project: string },
    body: string,
    health = "on_track",
    key?: string,
  ) {
    const path =
      "product" in target
        ? `/api/v1/products/${target.product}/status-updates`
        : `/api/v1/projects/${target.project}/status-updates`;
    return ok(
      await request("POST", path, { json: { body, health }, key }),
      "status update",
    );
  }

  return { get, item, project, statusUpdate };
}
