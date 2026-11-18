import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { activityEvent, projectProduct } from "../db/schema.js";
import { createEventBus } from "../events/bus.js";
import { testPullRequests, testWebhooks } from "../test-app.js";
import {
  ForbiddenError,
  ForbiddenScopeError,
  IdempotencyKeyReusedError,
  NotFoundError,
  ValidationError,
} from "./errors.js";
import { createService } from "./index.js";
import {
  authenticateKey,
  createBot,
  editKeyScope,
  type KeyScopeInput,
} from "./keys.js";

const dir = mkdtempSync(join(tmpdir(), "trail-idempotent-replay-"));
const db = openDatabase(join(dir, "trail.db"));
migrate(db);
afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

const service = createService({
  db,
  bus: createEventBus(),
  webhooks: testWebhooks,
  pullRequests: testPullRequests(db),
});

// the operator's unrestricted bot seeds everything and owns every product
const admin = createBot(db, "admin").actor;

for (const key of ["ATL", "BTA"]) {
  service.createProduct(admin, { key, name: `Product ${key}` });
}
service.createProject(admin, {
  name: "Recon",
  slug: "recon",
  products: ["ATL", "BTA"],
});
service.createProject(admin, { name: "Solo", slug: "solo", products: ["BTA"] });

/** A bot's key minted with `scope`, and the actor it authenticates as now. */
function keyed(name: string, scope: KeyScopeInput) {
  const { key } = createBot(db, name, { scope });
  const now = () => {
    const actor = authenticateKey(db, key);
    if (!actor) throw new Error("minted key did not authenticate");
    return actor;
  };
  return { prefix: key.slice(6, 14), now };
}

/** The error `call` throws; fails the test when it throws none. */
function thrown(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

const eventCount = () => db.select().from(activityEvent).all().length;
const itemCount = () => service.listItems(admin, { limit: 200 }).items.length;

describe("a file_issue replay", () => {
  test("of an item that has left the key's one project is the 404 a read of it is, without its title", () => {
    const bot = keyed("leaver", { projects: ["recon"] });
    const send = () =>
      service.fileIssue(
        bot.now(),
        { product: "ATL", project: "recon", title: "secret left behind" },
        { idempotencyKey: "left" },
      );
    const first = send();
    service.removeFromProject(admin, "recon", [first.key]);
    const count = itemCount();

    const error = thrown(send);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe(
      thrown(() => service.getItem(bot.now(), first.id)).message,
    );
    expect(error.message).not.toContain("secret left behind");
    expect(itemCount()).toBe(count);
  });

  test("by a key whose project was taken off it is the 404 a new filing gets", () => {
    const bot = keyed("narrowed-project", { projects: ["recon", "solo"] });
    const send = (idempotencyKey: string) =>
      service.fileIssue(
        bot.now(),
        { product: "ATL", project: "recon", title: "before the edit" },
        { idempotencyKey },
      );
    send("project-gone");
    editKeyScope(db, bot.prefix, { removeProjects: ["recon"] });
    const count = itemCount();

    const error = thrown(() => send("project-gone"));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe(thrown(() => send("project-fresh")).message);
    expect(itemCount()).toBe(count);
  });

  test("by a key whose product was taken off it is the error a new filing gets", () => {
    const bot = keyed("narrowed-product", { products: ["ATL", "BTA"] });
    const send = (idempotencyKey: string) =>
      service.fileIssue(
        bot.now(),
        { product: "ATL", title: "before the edit" },
        { idempotencyKey },
      );
    send("product-gone");
    editKeyScope(db, bot.prefix, { removeProducts: ["ATL"] });
    const count = itemCount();

    // ATL is still read through project recon, so a new filing on it is a 403, not a 404
    const error = thrown(() => send("product-gone"));
    expect(error).toBeInstanceOf(ForbiddenScopeError);
    expect(error.message).toBe(thrown(() => send("product-fresh")).message);
    expect(itemCount()).toBe(count);
  });

  test("by an unchanged key returns the first item and writes nothing", () => {
    const bot = keyed("steady", { projects: ["recon"] });
    const send = () =>
      service.fileIssue(
        bot.now(),
        { product: "BTA", project: "recon", title: "steady" },
        { idempotencyKey: "steady" },
      );
    const first = send();
    const count = itemCount();
    const events = eventCount();
    expect(send()).toEqual(first);
    expect(itemCount()).toBe(count);
    expect(eventCount()).toBe(events);
  });

  test("naming only a project replays once that project draws from another product too", () => {
    const growing = service.createProject(admin, {
      name: "Growing",
      slug: "growing",
      products: ["BTA"],
    });
    const bot = keyed("project-only-filer", { projects: ["growing"] });
    const send = () =>
      service.fileIssue(
        bot.now(),
        { project: "growing", title: "into its one product" },
        { idempotencyKey: "growing-one" },
      );
    const first = send();
    // a product joins a project only with an item added from it; this adds ATL with none
    const atl = service.getProduct(admin, "ATL").id;
    db.insert(projectProduct)
      .values({ projectId: growing.id, productId: atl })
      .run();
    expect(() =>
      service.fileIssue(bot.now(), { project: "growing", title: "fresh" }),
    ).toThrow(ValidationError);
    expect(send()).toEqual(first);
  });

  test("names only the projects the replaying key reaches now", () => {
    service.createProject(admin, {
      name: "Pair",
      slug: "pair",
      products: ["ATL"],
    });
    const bot = keyed("moved-project", { projects: ["recon"] });
    const send = () =>
      service.fileIssue(
        bot.now(),
        { product: "ATL", title: "filed into the key's one project" },
        { idempotencyKey: "moved" },
      );
    const first = send();
    expect(first.projects.map((p) => p.slug)).toEqual(["recon"]);
    service.addToProject(admin, "pair", [first.key]);
    editKeyScope(db, bot.prefix, {
      removeProjects: ["recon"],
      addProjects: ["pair"],
    });

    const replayed = send();
    expect(replayed.id).toBe(first.id);
    expect(replayed.projects).toEqual([{ slug: "pair", name: "Pair" }]);
  });

  test("with a different body is still a reused key, even once the item left the project", () => {
    const bot = keyed("reuser", { projects: ["recon"] });
    const first = service.fileIssue(
      bot.now(),
      { product: "ATL", project: "recon", title: "first body" },
      { idempotencyKey: "reused" },
    );
    service.removeFromProject(admin, "recon", [first.key]);
    expect(() =>
      service.fileIssue(
        bot.now(),
        { product: "ATL", project: "recon", title: "second body" },
        { idempotencyKey: "reused" },
      ),
    ).toThrow(IdempotencyKeyReusedError);
  });
});

describe("an add_todo replay", () => {
  test("once the caller no longer owns the product is the 403 a new add_todo gets", () => {
    const owner = createBot(db, "former-owner").actor;
    service.createProduct(owner, { key: "OWN", name: "Owned" });
    const send = (idempotencyKey: string) =>
      service.addTodo(
        owner,
        { product: "OWN", title: "mine for now" },
        { idempotencyKey },
      );
    send("todo-once");
    service.updateProduct(owner, "OWN", { owner: "admin" });
    const count = itemCount();

    const error = thrown(() => send("todo-once"));
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.message).toBe(thrown(() => send("todo-fresh")).message);
    expect(itemCount()).toBe(count);
  });

  test("naming no product replays once the caller owns a second product", () => {
    const owner = createBot(db, "grows-products").actor;
    service.createProduct(owner, { key: "ONE", name: "One" });
    const send = () =>
      service.addTodo(
        owner,
        { title: "on my one product" },
        { idempotencyKey: "own-one" },
      );
    const first = send();
    service.createProduct(owner, { key: "TWO", name: "Two" });
    expect(() => service.addTodo(owner, { title: "fresh" })).toThrow(
      ValidationError,
    );
    expect(send()).toEqual(first);
  });
});

describe("a comment replay", () => {
  test("on an item that has left the key's one project is the 404 a new comment gets", () => {
    const bot = keyed("commenter", { projects: ["recon"] });
    const item = service.fileIssue(bot.now(), {
      product: "ATL",
      project: "recon",
      title: "to comment on",
    });
    const send = (idempotencyKey: string) =>
      service.addComment(
        bot.now(),
        { issueId: item.key, body: "noted" },
        { idempotencyKey },
      );
    const first = send("comment-once");
    expect(send("comment-once")).toEqual(first);
    service.removeFromProject(admin, "recon", [item.key]);

    const error = thrown(() => send("comment-once"));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe(thrown(() => send("comment-fresh")).message);
    expect(error.message).not.toContain("to comment on");
    expect(service.listComments(admin, item.key).items).toHaveLength(1);
  });
});

describe("a status update replay", () => {
  const updateCount = (target: { product: string } | { project: string }) =>
    service.listStatusUpdates(admin, target, { limit: 200 }).items.length;

  test("on a project taken off the key is the 404 a new post gets", () => {
    const bot = keyed("project-poster", { projects: ["recon", "solo"] });
    const send = (idempotencyKey: string) =>
      service.createStatusUpdate(
        bot.now(),
        { project: "recon", body: "on track", health: "on_track" },
        { idempotencyKey },
      );
    const first = send("project-post");
    expect(send("project-post")).toEqual(first);
    editKeyScope(db, bot.prefix, { removeProjects: ["recon"] });

    const error = thrown(() => send("project-post"));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe(thrown(() => send("project-fresh")).message);
    expect(updateCount({ project: "recon" })).toBe(1);
  });

  test("on a product taken off the key is the 404 a new post gets", () => {
    const bot = keyed("product-poster", { products: ["ATL", "BTA"] });
    const send = (idempotencyKey: string) =>
      service.createStatusUpdate(
        bot.now(),
        { product: "ATL", body: "on track", health: "on_track" },
        { idempotencyKey },
      );
    const first = send("product-post");
    expect(send("product-post")).toEqual(first);
    const count = updateCount({ product: "ATL" });
    editKeyScope(db, bot.prefix, { removeProducts: ["ATL"] });

    const error = thrown(() => send("product-post"));
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe(thrown(() => send("product-fresh")).message);
    expect(updateCount({ product: "ATL" })).toBe(count);
  });
});

describe("a create_project replay", () => {
  test("of a project the key no longer reaches is the 404 a read of it is", () => {
    const bot = keyed("project-maker", { products: ["ATL", "BTA"] });
    service.updateProduct(admin, "ATL", { owner: "project-maker" });
    const send = () =>
      service.createProject(
        bot.now(),
        { name: "Defaulted", slug: "defaulted" },
        { idempotencyKey: "project-once" },
      );
    const first = send();
    expect(first.products.map((p) => p.key)).toEqual(["ATL"]);
    expect(send()).toEqual(first);
    editKeyScope(db, bot.prefix, { removeProducts: ["ATL"] });
    const count = service.listProjects(admin, { limit: 200 }).items.length;

    const error = thrown(send);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.message).toBe(
      thrown(() => service.getProject(bot.now(), "defaulted")).message,
    );
    expect(service.listProjects(admin, { limit: 200 }).items).toHaveLength(
      count,
    );
  });
});

describe("a create_label replay", () => {
  test("once the caller no longer owns the product is the 403 a new label gets", () => {
    const owner = createBot(db, "label-owner").actor;
    service.createProduct(owner, { key: "LBL", name: "Labelled" });
    const send = (idempotencyKey: string) =>
      service.createLabel(
        owner,
        { productId: "LBL", name: "bug" },
        { idempotencyKey },
      );
    const first = send("label-once");
    expect(send("label-once")).toEqual(first);
    service.updateProduct(owner, "LBL", { owner: "admin" });

    const error = thrown(() => send("label-once"));
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.message).toBe(thrown(() => send("label-fresh")).message);
  });
});
