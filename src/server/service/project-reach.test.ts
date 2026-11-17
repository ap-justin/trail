import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { issue } from "../db/schema.js";
import { createEventBus } from "../events/bus.js";
import { testWebhooks } from "../test-app.js";
import { ForbiddenScopeError, NotFoundError } from "./errors.js";
import { createService } from "./index.js";
import {
  authenticateKey,
  createBot,
  editKeyScope,
  type KeyScopeInput,
} from "./keys.js";

const dir = mkdtempSync(join(tmpdir(), "trail-project-reach-"));
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
});

// the operator's unrestricted bot seeds everything
const admin = createBot(db, "admin").actor;

/** A bot acting through a key minted with `scope`, and that key's prefix. */
function keyed(name: string, scope: KeyScopeInput) {
  const { key } = createBot(db, name, { scope });
  const actor = authenticateKey(db, key);
  if (!actor) throw new Error("minted key did not authenticate");
  return { actor, prefix: key.slice(6, 14), token: key };
}
/** The key's actor as it authenticates now, after a scope edit. */
const fresh = (token: string) => {
  const actor = authenticateKey(db, token);
  if (!actor) throw new Error("key did not authenticate");
  return actor;
};

for (const key of ["ATL", "BTA", "CTX"]) {
  service.createProduct(admin, { key, name: `Product ${key}` });
}
const todo = (product: string, title: string) =>
  service.addTodo(admin, { product, title, labels: ["bug"] }).key;
const atlIn = todo("ATL", "atl in recon");
const atlOut = todo("ATL", "atl outside");
const btaIn = todo("BTA", "bta in recon");
const btaOut = todo("BTA", "bta outside");
const ctxOnly = todo("CTX", "ctx alone");
service.createProject(admin, {
  name: "Recon",
  slug: "recon",
  products: ["ATL", "BTA"],
});
service.createProject(admin, {
  name: "Other",
  slug: "other",
  products: ["ATL"],
});
service.addToProject(admin, "recon", [atlIn, btaIn]);
service.addToProject(admin, "other", [atlOut]);

const alpha = keyed("alpha", { projects: ["recon"] });

describe("a key scoped to project recon only", () => {
  test("gets an item in the project by key and id", () => {
    expect(service.getItem(alpha.actor, atlIn).title).toBe("atl in recon");
    const bta = service.getItem(admin, btaIn);
    expect(service.getItem(alpha.actor, bta.id).key).toBe(btaIn);
  });

  test("gets the 404 a missing item gets for an item outside the project in the same product", () => {
    const missing = () => service.getItem(alpha.actor, "ATL-999");
    expect(missing).toThrow(NotFoundError);
    const message = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as Error).message.replace(/ATL-\d+/, "REF");
      }
    };
    expect(message(() => service.getItem(alpha.actor, atlOut))).toBe(
      message(missing),
    );
  });

  test("finds an item in the project by source key, and not one outside", () => {
    const sourced = (ref: string, sourceKey: string) =>
      db
        .update(issue)
        .set({ sourceKey })
        .where(eq(issue.id, service.getItem(admin, ref).id))
        .run();
    sourced(btaIn, "LIN-1");
    sourced(btaOut, "LIN-2");
    expect(service.getItem(alpha.actor, "lin-1").key).toBe(btaIn);
    expect(() => service.getItem(alpha.actor, "LIN-2")).toThrow(NotFoundError);
  });

  test("lists the project's items and none of the rest of its products", () => {
    const keys = (query = {}) =>
      service
        .listItems(alpha.actor, query)
        .items.map((i) => i.key)
        .sort();
    expect(keys()).toEqual([atlIn, btaIn].sort());
    expect(keys({ product: "BTA" })).toEqual([btaIn]);
    expect(keys({ project: "recon" })).toEqual([atlIn, btaIn].sort());
    expect(() => keys({ product: "CTX" })).toThrow(NotFoundError);
    expect(() => keys({ project: "other" })).toThrow(NotFoundError);
  });

  test("reads and adds comments on a project item, and not on one outside", () => {
    service.addComment(admin, { issueId: atlIn, body: "seen" });
    service.addComment(admin, { issueId: atlOut, body: "hidden" });
    service.addComment(alpha.actor, { issueId: atlIn, body: "on it" });
    expect(
      service.listComments(alpha.actor, atlIn).items.map((c) => c.body),
    ).toEqual(["seen", "on it"]);
    expect(() => service.listComments(alpha.actor, atlOut)).toThrow(
      NotFoundError,
    );
    expect(() =>
      service.addComment(alpha.actor, { issueId: atlOut, body: "x" }),
    ).toThrow(NotFoundError);
  });

  test("reads a project item's links, and of its projects only those it reaches", () => {
    service.updateItem(admin, btaIn, {
      links: [{ url: "https://example.com/spec", title: "spec" }],
    });
    service.addToProject(admin, "other", [atlIn]);
    try {
      expect(service.getItem(alpha.actor, btaIn).links).toEqual([
        { url: "https://example.com/spec", title: "spec" },
      ]);
      expect(service.getItem(alpha.actor, atlIn).projects).toEqual([
        { slug: "recon", name: "Recon" },
      ]);
      expect(
        service
          .listItems(alpha.actor, { project: "recon" })
          .items.find((i) => i.key === atlIn)?.projects,
      ).toEqual([{ slug: "recon", name: "Recon" }]);
      expect(service.getItem(admin, atlIn).projects.map((p) => p.slug)).toEqual(
        ["other", "recon"],
      );
    } finally {
      service.removeFromProject(admin, "other", [atlIn]);
    }
  });

  test("lists and gets its project with counts of the project's items only, and no other project", () => {
    expect(service.listProjects(alpha.actor).items.map((p) => p.slug)).toEqual([
      "recon",
    ]);
    const recon = service.getProject(alpha.actor, "recon");
    expect(recon.products.map((p) => p.key)).toEqual(["ATL", "BTA"]);
    expect(recon.hiddenProducts).toBe(false);
    expect(recon.counts).toEqual({
      triage: 0,
      open: 2,
      in_progress: 0,
      done: 0,
      canceled: 0,
    });
    expect(() => service.getProject(alpha.actor, "other")).toThrow(
      NotFoundError,
    );
  });

  test("lists and gets the products its project draws from, by id, name and key only, and no other", () => {
    const named = (key: string) => ({
      id: service.getProduct(admin, key).id,
      key,
      name: `Product ${key}`,
    });
    expect(
      service
        .listProducts(alpha.actor)
        .items.sort((a, b) => a.key.localeCompare(b.key)),
    ).toEqual([named("ATL"), named("BTA")]);
    expect(service.getProduct(alpha.actor, "bta")).toEqual(named("BTA"));
    expect(() => service.getProduct(alpha.actor, "CTX")).toThrow(NotFoundError);
  });

  test("lists the labels of a product its project draws from, to file with", () => {
    expect(
      service.listLabels(alpha.actor, "ATL").items.map((l) => l.name),
    ).toEqual(["bug"]);
    expect(() => service.listLabels(alpha.actor, "CTX")).toThrow(NotFoundError);
  });

  test("reads and posts its project's status updates, and none of its products'", () => {
    service.createStatusUpdate(admin, {
      project: "recon",
      body: "recon fine",
      health: "on_track",
    });
    service.createStatusUpdate(admin, {
      product: "ATL",
      body: "atl fine",
      health: "on_track",
    });
    service.createStatusUpdate(alpha.actor, {
      project: "recon",
      body: "alpha here",
      health: "at_risk",
    });
    expect(
      service
        .listStatusUpdates(alpha.actor, { project: "recon" })
        .items.map((u) => u.body),
    ).toEqual(["alpha here", "recon fine"]);
    expect(
      service.getProject(alpha.actor, "recon").latestStatusUpdate?.body,
    ).toBe("alpha here");
    expect(() =>
      service.listStatusUpdates(alpha.actor, { product: "ATL" }),
    ).toThrow(NotFoundError);
    expect(() =>
      service.createStatusUpdate(alpha.actor, {
        product: "ATL",
        body: "x",
        health: "on_track",
      }),
    ).toThrow(NotFoundError);
  });

  test("reads activity on its project and its items only, with product and project filters", () => {
    service.addToProject(admin, "other", [atlIn]);
    service.removeFromProject(admin, "other", [atlIn]);
    // its own comments, so the feed read stands without the tests before it
    service.addComment(admin, { issueId: btaIn, body: "for the feed" });
    service.addComment(admin, { issueId: atlOut, body: "not for the feed" });
    const items = [atlIn, btaIn].map((ref) => service.getItem(admin, ref).id);
    const comments = [atlIn, btaIn].flatMap((ref) =>
      service.listComments(admin, ref).items.map((c) => c.id),
    );
    const recon = service.getProject(admin, "recon").id;
    const feed = (query = {}) =>
      service.listActivity(alpha.actor, { limit: 200, ...query }).items;
    const all = feed();
    for (const e of all) {
      const ok =
        (e.subjectType === "issue" &&
          items.includes(e.subjectId) &&
          (e.projectId === null || e.projectId === recon)) ||
        (e.subjectType === "comment" && comments.includes(e.subjectId)) ||
        // the project's own events, and items joining or leaving it, whichever item
        e.projectId === recon;
      expect(ok, `${e.action} ${e.subjectType} ${e.productKey}`).toBe(true);
    }
    const actions = all.map((e) => e.action);
    expect(actions).toContain("project.item_added");
    expect(actions).toContain("comment.created");
    expect(actions.filter((a) => a === "issue.created")).toHaveLength(2);
    expect(feed({ product: "BTA" }).every((e) => e.productKey === "BTA")).toBe(
      true,
    );
    expect(feed({ product: "BTA" }).map((e) => e.subjectId)).toContain(
      items[1],
    );
    expect(feed({ project: "recon" }).every((e) => e.projectId === recon)).toBe(
      true,
    );
    expect(() => feed({ product: "CTX" })).toThrow(NotFoundError);
  });
});

describe("a key with a product and a project", () => {
  const beta = keyed("beta", { products: ["CTX"], projects: ["recon"] });

  test("reaches every item of its product and the project's items, and nothing else", () => {
    expect(
      service
        .listItems(beta.actor)
        .items.map((i) => i.key)
        .sort(),
    ).toEqual([atlIn, btaIn, ctxOnly].sort());
    expect(() => service.getItem(beta.actor, btaOut)).toThrow(NotFoundError);
    expect(
      service
        .listProducts(beta.actor)
        .items.map((p) => [p.key, "createdBy" in p])
        .sort(),
    ).toEqual([
      ["ATL", false],
      ["BTA", false],
      ["CTX", true],
    ]);
    expect(service.getProduct(beta.actor, "CTX")).toEqual(
      service.getProduct(admin, "CTX"),
    );
    expect(
      service.listStatusUpdates(beta.actor, { product: "CTX" }).items,
    ).toEqual([]);
    expect(() =>
      service.listStatusUpdates(beta.actor, { product: "BTA" }),
    ).toThrow(NotFoundError);
  });
});

describe("membership is read live", () => {
  test("an item added to the project is reached, and removed it is the missing 404 again", () => {
    const gamma = keyed("gamma", { projects: ["recon"] });
    const open = () => service.getProject(gamma.actor, "recon").counts.open;
    const openBefore = open();
    expect(() => service.getItem(gamma.actor, btaOut)).toThrow(NotFoundError);
    service.addToProject(admin, "recon", [btaOut]);
    expect(service.getItem(gamma.actor, btaOut).key).toBe(btaOut);
    expect(open()).toBe(openBefore + 1);
    service.removeFromProject(admin, "recon", [btaOut]);
    expect(() => service.getItem(gamma.actor, btaOut)).toThrow(NotFoundError);
    expect(open()).toBe(openBefore);
  });

  test("an item leaving the project shows its removal in the feed as the last of its events, as a webhook following the project receives it", () => {
    const watcher = keyed("watcher", { projects: ["recon"] });
    const leaver = service.addTodo(admin, {
      product: "BTA",
      title: "bta leaving",
    });
    const seen = () =>
      service.listActivity(watcher.actor, { limit: 200 }).items;
    /** newest first, as the feed lists them */
    const actionsOf = (id: string) =>
      seen()
        .filter((e) => e.subjectId === id)
        .map((e) => e.action);
    service.addToProject(admin, "recon", [leaver.key]);
    service.updateItem(admin, leaver.key, { title: "in recon a while" });
    const during = service.addComment(admin, {
      issueId: leaver.key,
      body: "written in the project",
    });
    expect(actionsOf(leaver.id)).toEqual([
      "issue.updated",
      "project.item_added",
      "issue.created",
    ]);
    expect(actionsOf(during.id)).toEqual(["comment.created"]);

    service.removeFromProject(admin, "recon", [leaver.key]);
    service.updateItem(admin, leaver.key, { title: "outside again" });
    const after = service.addComment(admin, {
      issueId: leaver.key,
      body: "written after it left",
    });
    // what it did in the project stays, as of its removal; what came after is out of reach
    expect(actionsOf(leaver.id)).toEqual([
      "project.item_removed",
      "project.item_added",
    ]);
    expect(actionsOf(during.id)).toEqual([]);
    expect(actionsOf(after.id)).toEqual([]);
  });

  test("a product joining the project is named, and none of its other items reached", () => {
    const delta = keyed("delta", { projects: ["other"] });
    expect(() => service.getProduct(delta.actor, "CTX")).toThrow(NotFoundError);
    service.addToProject(admin, "other", [ctxOnly]);
    try {
      expect(service.getProduct(delta.actor, "CTX").key).toBe("CTX");
      expect(service.getItem(delta.actor, ctxOnly).key).toBe(ctxOnly);
      expect(
        service.getProject(delta.actor, "other").products.map((p) => p.key),
      ).toEqual(["ATL", "CTX"]);
    } finally {
      service.removeFromProject(admin, "other", [ctxOnly]);
    }
  });

  test("a scope edit takes effect on the key's next call", () => {
    const epsilon = keyed("epsilon", { projects: ["other"] });
    expect(() => service.getItem(epsilon.actor, atlIn)).toThrow(NotFoundError);
    editKeyScope(db, epsilon.prefix, { addProjects: ["recon"] });
    expect(service.getItem(fresh(epsilon.token), atlIn).key).toBe(atlIn);
  });
});

describe("an unrestricted key", () => {
  test("still reaches every product, project and item with project-scoped keys about", () => {
    const open = keyed("omega", {});
    expect(open.actor.scope).toEqual({
      products: null,
      projects: [],
      actions: null,
    });
    const keysFor = (actor: Parameters<typeof service.listItems>[0]) =>
      service
        .listItems(actor, { limit: 200 })
        .items.map((i) => i.key)
        .sort();
    expect(keysFor(open.actor)).toEqual(keysFor(admin));
    expect(keysFor(open.actor)).toEqual(
      expect.arrayContaining([atlIn, atlOut, btaIn, btaOut, ctxOnly]),
    );
    expect(
      service
        .listProjects(open.actor)
        .items.map((p) => p.slug)
        .sort(),
    ).toEqual(["other", "recon"]);
    service.createStatusUpdate(admin, {
      product: "ATL",
      body: "atl for the open key",
      health: "on_track",
    });
    expect(
      service
        .listStatusUpdates(open.actor, { product: "ATL" })
        .items.map((u) => u.body),
    ).toContain("atl for the open key");
  });
});

describe("the guards on a restricted key hold for a project-only key", () => {
  const zeta = keyed("zeta", { projects: ["recon"] });

  test("whoami names the products its project draws from and owns none", () => {
    const me = service.whoami(zeta.actor);
    expect(me.products.map((p) => p.key)).toEqual(["ATL", "BTA"]);
    expect(me.ownProducts).toEqual([]);
  });

  test("creating a product is refused, saying what the key reaches", () => {
    expect(() =>
      service.createProduct(zeta.actor, { key: "NEW", name: "new" }),
    ).toThrow(
      new ForbiddenScopeError(
        "this key may not create a product: it reaches only project recon. Ask whoever minted the key for one with no product or project list.",
      ),
    );
  });

  test("importing a product is refused, even one its project draws from", () => {
    for (const key of ["ATL", "NEW"]) {
      expect(() =>
        service.importProject(zeta.actor, {
          externalRef: `ext-${key}`,
          key,
          name: key,
        }),
      ).toThrow(
        new ForbiddenScopeError(
          "this key may not import a product: it reaches only project recon, and an import needs a key that lists the product. Ask whoever minted the key for one that lists the product, or one with no product or project list.",
        ),
      );
    }
  });
});

describe("a project-only bot works items as any non-owner bot does", () => {
  const eta = keyed("eta", { projects: ["recon"] });

  test("moves a project item assigned to it, and none outside the project", () => {
    service.updateItem(admin, btaIn, { assigneeId: eta.actor.id });
    expect(
      service.updateItem(eta.actor, btaIn, { status: "in_progress" }).status,
    ).toBe("in_progress");
    // back to open, so the counts the tests above read don't depend on this one running last
    service.updateItem(admin, btaIn, { status: "open" });
    service.updateItem(admin, btaOut, { assigneeId: eta.actor.id });
    expect(() =>
      service.updateItem(eta.actor, btaOut, { status: "in_progress" }),
    ).toThrow(NotFoundError);
  });

  test("a product key sent as a project gets the hint to send it as product", () => {
    expect(() => service.listItems(eta.actor, { project: "BTA" })).toThrow(
      'no project BTA: that is a product key, send it as product (product: "BTA")',
    );
  });
});
