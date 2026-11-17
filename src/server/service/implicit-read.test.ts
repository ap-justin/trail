import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { projectProduct } from "../db/schema.js";
import { createEventBus } from "../events/bus.js";
import { testWebhooks } from "../test-app.js";
import { ForbiddenScopeError, NotFoundError } from "./errors.js";
import { createService, type IssuePatch } from "./index.js";
import { authenticateKey, createBot, type KeyScopeInput } from "./keys.js";
import { setProductOwner } from "./product-admin.js";

const dir = mkdtempSync(join(tmpdir(), "trail-implicit-read-"));
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

// the operator's unrestricted bot seeds everything; alpha owns ATL and beta BTA
const admin = createBot(db, "admin").actor;

/** A bot acting through a key minted with `scope`. */
function keyed(name: string, scope: KeyScopeInput) {
  const { key } = createBot(db, name, { scope });
  const actor = authenticateKey(db, key);
  if (!actor) throw new Error("minted key did not authenticate");
  return actor;
}

for (const key of ["ATL", "BTA"]) {
  service.createProduct(admin, { key, name: `Product ${key}` });
}
const todo = (product: string, title: string) =>
  service.addTodo(admin, { product, title }).key;
const atlIn = todo("ATL", "atl in recon");
const atlOut = todo("ATL", "atl outside");
const btaIn = todo("BTA", "bta in recon");
const btaOut = todo("BTA", "bta outside");
service.createProject(admin, {
  name: "Recon",
  slug: "recon",
  products: ["ATL", "BTA"],
});
service.addToProject(admin, "recon", [atlIn, btaIn]);

const beta = keyed("beta", { products: ["BTA"] });
const alpha = createBot(db, "alpha").actor;
setProductOwner(db, "ATL", "alpha");
setProductOwner(db, "BTA", "beta");

// a person invited to BTA, as /api/web acts for them
const person = {
  id: admin.id,
  kind: "human" as const,
  scope: {
    products: [{ id: service.getProduct(admin, "BTA").id, key: "BTA" }],
    projects: [],
    actions: null,
  },
};

describe("a BTA-only key, BTA being in project recon", () => {
  test("reads and comments on recon's ATL items, and not on ATL items outside recon", () => {
    expect(service.getItem(beta, atlIn).title).toBe("atl in recon");
    service.addComment(beta, { issueId: atlIn, body: "seen from BTA" });
    expect(service.listComments(beta, atlIn).items.map((c) => c.body)).toEqual([
      "seen from BTA",
    ]);
    expect(() => service.getItem(beta, atlOut)).toThrow(NotFoundError);
    expect(() =>
      service.addComment(beta, { issueId: atlOut, body: "x" }),
    ).toThrow(NotFoundError);
    expect(service.getItem(beta, btaOut).key).toBe(btaOut);
    expect(service.getItem(beta, btaIn).key).toBe(btaIn);
  });
});

describe("get_item's access says why the key reaches the item", () => {
  test('"product" for its own product\'s items, "via_project" for recon\'s ATL items', () => {
    expect(service.getItem(beta, btaOut).access).toBe("product");
    expect(service.getItem(beta, btaIn).access).toBe("product");
    expect(service.getItem(beta, atlIn).access).toBe("via_project");
  });

  test('"project" for a key listing recon, and the explicit grant wins over the implicit read', () => {
    expect(
      service.getItem(keyed("scout", { projects: ["recon"] }), atlIn).access,
    ).toBe("project");
    const both = keyed("both", { products: ["BTA"], projects: ["recon"] });
    expect(service.getItem(both, atlIn).access).toBe("project");
    expect(service.getItem(both, btaIn).access).toBe("product");
  });

  test('"product" for an unrestricted key, and no access for a person', () => {
    expect(service.getItem(admin, atlIn).access).toBe("product");
    expect(service.getItem(person, btaIn)).not.toHaveProperty("access");
    expect(() => service.getItem(person, atlIn)).toThrow(NotFoundError);
  });
});

/** The error `fn` throws. */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

describe("on an item it reaches only through recon, a BTA-only key may comment and nothing else", () => {
  const refusal = (doing: string) =>
    `${atlIn} is visible to this key only through project recon, which lets it read the item and comment on it (add_comment) and nothing else: to ${doing}, the bot needs a key that lists product ATL or project recon. Ask alpha, the owner of ATL, for that grant.`;

  test("update_item is a 403 naming the project, the grants and the owner, whatever it changes", () => {
    const patches: IssuePatch[] = [
      { status: "in_progress" },
      { assigneeId: "beta" },
      { labels: ["bug"] },
      { addLabels: ["bug"] },
      { type: "issue" },
      { title: "renamed" },
      { status: "canceled" },
      { addLinks: [{ url: "https://example.com/x" }] },
    ];
    for (const patch of patches) {
      const error = thrown(() => service.updateItem(beta, atlIn, patch));
      expect(error, JSON.stringify(patch)).toBeInstanceOf(ForbiddenScopeError);
      expect(error.message).toBe(refusal("update an item"));
    }
    expect(service.getItem(admin, atlIn)).toMatchObject({
      title: "atl in recon",
      status: "open",
      labels: [],
    });
  });

  test("add_to_project and remove_from_project of the item are 403s; its own items it still adds", () => {
    service.createProject(admin, {
      name: "Side",
      slug: "side",
      products: ["BTA"],
    });
    const added = thrown(() => service.addToProject(beta, "side", [atlIn]));
    expect(added).toBeInstanceOf(ForbiddenScopeError);
    expect(added.message).toBe(refusal("add it to a project"));
    const removed = thrown(() =>
      service.removeFromProject(beta, "recon", [atlIn]),
    );
    expect(removed).toBeInstanceOf(ForbiddenScopeError);
    expect(removed.message).toBe(refusal("remove it from a project"));
    expect(service.getItem(admin, atlIn).projects.map((p) => p.slug)).toEqual([
      "recon",
    ]);
    expect(service.addToProject(beta, "side", [btaOut]).added).toEqual([
      btaOut,
    ]);
  });

  test("assigned to the key's own bot, the item is still comment-only: a status change is the same 403", () => {
    const assignee = service.getItem(admin, atlIn).assignee?.id ?? null;
    service.updateItem(alpha, atlIn, { assigneeId: beta.id });
    try {
      const error = thrown(() =>
        service.updateItem(beta, atlIn, { status: "in_progress" }),
      );
      expect(error).toBeInstanceOf(ForbiddenScopeError);
      expect(error.message).toBe(refusal("update an item"));
      expect(service.getItem(admin, atlIn).status).toBe("open");
    } finally {
      service.updateItem(alpha, atlIn, { assigneeId: assignee });
    }
  });

  test("with no owner on ATL, the refusal says to ask whoever minted the key", () => {
    db.$client
      .prepare("update product set owner_id = null where key = 'ATL'")
      .run();
    try {
      expect(
        thrown(() => service.updateItem(beta, atlIn, { status: "done" }))
          .message,
      ).toMatch(
        /or project recon\. Ask whoever minted the key for that grant\.$/,
      );
    } finally {
      setProductOwner(db, "ATL", "alpha");
    }
  });

  test("a key listing recon, or ATL, updates the item as before", () => {
    const listing = keyed("lister", { products: ["BTA"], projects: ["recon"] });
    expect(
      service.updateItem(listing, atlIn, { description: "from the lister" })
        .description,
    ).toBe("from the lister");
    const atl = keyed("atl-worker", { products: ["ATL"] });
    expect(
      service.updateItem(atl, atlIn, { description: "from ATL" }).description,
    ).toBe("from ATL");
  });
});

describe("remove_from_project on a project the key reads only through its products", () => {
  test("is a 403 for another product's item, naming the grants and the owner, and the item stays", () => {
    service.createProject(admin, {
      name: "ATL list",
      slug: "atl-list",
      products: ["ATL"],
    });
    const both = service.addTodo(alpha, {
      product: "ATL",
      title: "atl in recon and atl-list",
    }).key;
    service.addToProject(admin, "recon", [both]);
    service.addToProject(admin, "atl-list", [both]);
    const mixed = keyed("mixed", { products: ["BTA"], projects: ["atl-list"] });
    const error = thrown(() =>
      service.removeFromProject(mixed, "recon", [both]),
    );
    expect(error).toBeInstanceOf(ForbiddenScopeError);
    expect(error.message).toBe(
      `${both} is in project recon, which this key reads only through its products: to remove it from recon, the bot needs a key that lists product ATL or project recon. Ask alpha, the owner of ATL, for that grant.`,
    );
    expect(
      service
        .getItem(admin, both)
        .projects.map((p) => p.slug)
        .sort(),
    ).toEqual(["atl-list", "recon"]);
    expect(
      service.removeFromProject(mixed, "atl-list", [both]).removed,
    ).toEqual([both]);
    service.removeFromProject(admin, "recon", [both]);
  });

  test("goes through for an item of the key's own product", () => {
    expect(service.removeFromProject(beta, "recon", [btaIn]).removed).toEqual([
      btaIn,
    ]);
    service.addToProject(admin, "recon", [btaIn]);
  });

  test("lists another product's item that isn't in the project as unchanged", () => {
    service.createProject(admin, {
      name: "ATL only",
      slug: "atl-only",
      products: ["ATL"],
    });
    const outside = service.addTodo(alpha, {
      product: "ATL",
      title: "atl in atl-only, not recon",
    }).key;
    service.addToProject(admin, "atl-only", [outside]);
    const lister = keyed("atl-only-lister", {
      products: ["BTA"],
      projects: ["atl-only"],
    });
    expect(service.removeFromProject(lister, "recon", [outside])).toMatchObject(
      { removed: [], unchanged: [outside] },
    );
  });
});

describe("a BTA-only key files nothing through its implicit read", () => {
  const refusal =
    'this key reads product ATL only through project recon, which lets it read recon\'s ATL items and comment on them and file nothing on ATL: file on BTA (with project: "recon" to put the issue in recon), or get a key that lists product ATL or project recon. Ask alpha, the owner of ATL, for that grant.';
  const itemCount = () => service.listItems(admin, { limit: 200 }).items.length;

  test("file_issue on ATL, with or without project recon, is a 403 that writes nothing", () => {
    const before = itemCount();
    for (const input of [
      { product: "ATL", title: "no" },
      { product: "ATL", project: "recon", title: "no" },
    ]) {
      const error = thrown(() => service.fileIssue(beta, input));
      expect(error, JSON.stringify(input)).toBeInstanceOf(ForbiddenScopeError);
      expect(error.message).toBe(refusal);
    }
    expect(itemCount()).toBe(before);
  });

  test("file_issue on BTA into recon goes through, as it did", () => {
    const filed = service.fileIssue(beta, {
      product: "BTA",
      project: "recon",
      title: "from beta",
    });
    expect(filed.projects.map((p) => p.slug)).toEqual(["recon"]);
  });

  test("ATL itself stays out of reach: its status updates and todos are 404s pointing at recon", () => {
    const message =
      "this key reads product ATL only through project recon, which reaches recon's ATL items to read and comment on: anything on ATL itself needs a key that lists ATL";
    for (const call of [
      () => service.listStatusUpdates(beta, { product: "ATL" }),
      () => service.addTodo(beta, { product: "ATL", title: "no" }),
    ]) {
      const error = thrown(call);
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error.message).toBe(message);
    }
  });
});

describe("whoami", () => {
  test("lists the projects a key reads through its products, A to Z, and keeps scope to its explicit grants", () => {
    service.createProject(admin, {
      name: "Alpha",
      slug: "a-side",
      products: ["BTA"],
    });
    expect(service.whoami(beta).impliedProjects).toEqual([
      "a-side",
      "recon",
      "side",
    ]);
    expect(beta.scope?.projects).toEqual([]);
    // products are those it files on, which the implicit read adds none to
    expect(service.whoami(beta).products.map((p) => p.key)).toEqual(["BTA"]);
    const lister = keyed("whoami-lister", {
      products: ["BTA"],
      projects: ["recon"],
    });
    expect(service.whoami(lister).impliedProjects).toEqual(["a-side", "side"]);
    expect(
      service.whoami(keyed("whoami-recon", { projects: ["recon"] }))
        .impliedProjects,
    ).toEqual([]);
    expect(service.whoami(admin).impliedProjects).toEqual([]);
  });
});

describe("the readers around an item follow the implicit read", () => {
  test("list_items lists recon's ATL items and no other ATL item, and filters by ATL and recon", () => {
    const keys = (query = {}) =>
      service.listItems(beta, { limit: 200, ...query }).items.map((i) => i.key);
    expect(keys()).toContain(atlIn);
    expect(keys()).not.toContain(atlOut);
    expect(keys({ product: "ATL" })).toEqual([atlIn]);
    expect(keys({ project: "recon" })).toContain(atlIn);
    expect(
      service
        .listItems(beta, { project: "recon" })
        .items.find((i) => i.key === atlIn)?.projects,
    ).toEqual([{ slug: "recon", name: "Recon" }]);
  });

  test("names ATL by id, key and name, and keeps BTA whole", () => {
    const atl = service.getProduct(admin, "ATL");
    expect(service.getProduct(beta, "ATL")).toEqual({
      id: atl.id,
      key: "ATL",
      name: "Product ATL",
    });
    expect(service.getProduct(beta, "BTA")).toHaveProperty("createdBy");
  });

  test("ATL's labels are a 404 naming recon, the grants and the owner, and a key listing recon lists them", () => {
    service.createLabel(alpha, { productId: "ATL", name: "bug" });
    const hidden = thrown(() => service.listLabels(beta, "ATL"));
    expect(hidden).toBeInstanceOf(NotFoundError);
    expect(hidden.message).toBe(
      "this key reads product ATL only through project recon, which shows ATL's name and key and not its labels: ATL's labels need a key that lists product ATL or project recon. Ask alpha, the owner of ATL, for that grant.",
    );
    expect(hidden.message).not.toContain("list_products");
    const listing = keyed("label-lister", { projects: ["recon"] });
    expect(service.listLabels(listing, "ATL").items.map((l) => l.name)).toEqual(
      ["bug"],
    );
  });

  test("recon's counts include its ATL items, as an unrestricted key counts them", () => {
    expect(service.getProject(beta, "recon").counts).toEqual(
      service.getProject(admin, "recon").counts,
    );
    expect(service.getProject(beta, "recon").hiddenProducts).toBe(false);
  });

  test("activity shows recon's ATL items and their comments, and nothing of ATL outside recon", () => {
    service.addComment(admin, { issueId: atlOut, body: "outside" });
    service.addComment(admin, { issueId: atlIn, body: "inside" });
    const [inId, outId] = [atlIn, atlOut].map(
      (ref) => service.getItem(admin, ref).id,
    );
    const outComments = service
      .listComments(admin, atlOut)
      .items.map((c) => c.id);
    const feed = service.listActivity(beta, { limit: 200 }).items;
    const subjects = feed.map((e) => e.subjectId);
    expect(subjects).toContain(inId);
    expect(subjects).not.toContain(outId);
    for (const id of outComments) expect(subjects).not.toContain(id);
    const comments = feed.filter(
      (e) => e.action === "comment.created" && e.productKey === "ATL",
    );
    expect(comments.map((e) => e.payload)).toContainEqual(
      expect.objectContaining({ body: "inside" }),
    );
    expect(
      service
        .listActivity(beta, { product: "ATL", limit: 200 })
        .items.every((e) => e.productKey === "ATL"),
    ).toBe(true);
  });
});

describe("the implicit read is live", () => {
  const reconId = () => service.getProject(admin, "recon").id;
  const btaId = () => service.getProduct(admin, "BTA").id;

  test("BTA leaving recon drops recon's ATL items, and BTA joining again brings them back", () => {
    const btaInRecon = service
      .listItems(admin, { project: "recon", product: "BTA", limit: 200 })
      .items.map((i) => i.key);
    // no call drops a product from a project; its items leave first, as the schema requires
    service.removeFromProject(admin, "recon", btaInRecon);
    db.delete(projectProduct)
      .where(
        and(
          eq(projectProduct.projectId, reconId()),
          eq(projectProduct.productId, btaId()),
        ),
      )
      .run();
    expect(() => service.getItem(beta, atlIn)).toThrow(NotFoundError);
    expect(service.whoami(beta).impliedProjects).not.toContain("recon");
    expect(() => service.getProject(beta, "recon")).toThrow(NotFoundError);
    service.addToProject(admin, "recon", btaInRecon);
    expect(service.getItem(beta, atlIn).access).toBe("via_project");
    expect(service.whoami(beta).impliedProjects).toContain("recon");
  });

  test("an item leaving recon is the missing 404 again, and back in recon it is read again", () => {
    service.removeFromProject(admin, "recon", [atlIn]);
    try {
      const missing = thrown(() => service.getItem(beta, "ATL-999"));
      const gone = thrown(() => service.getItem(beta, atlIn));
      expect(gone).toBeInstanceOf(NotFoundError);
      expect(gone.message).toBe(missing.message.replace("ATL-999", atlIn));
    } finally {
      service.addToProject(admin, "recon", [atlIn]);
    }
    expect(service.getItem(beta, atlIn).key).toBe(atlIn);
  });
});

describe("people and unrestricted keys are unchanged", () => {
  test("a person invited to BTA reads BTA's items and none of ATL's, recon's included", () => {
    const keys = service
      .listItems(person, { limit: 200 })
      .items.map((i) => i.productKey);
    expect(new Set(keys)).toEqual(new Set(["BTA"]));
    expect(() => service.getItem(person, atlIn)).toThrow(NotFoundError);
    expect(() => service.getProduct(person, "ATL")).toThrow(NotFoundError);
    const recon = service.getProject(person, "recon");
    expect(recon.products.map((p) => p.key)).toEqual(["BTA"]);
    expect(recon.counts).not.toEqual(service.getProject(admin, "recon").counts);
  });

  test("an unrestricted key reaches every item and updates recon's ATL items", () => {
    const wide = keyed("wide", {});
    expect(service.getItem(wide, atlOut).access).toBe("product");
    expect(service.whoami(wide).impliedProjects).toEqual([]);
    expect(
      service.updateItem(wide, atlIn, { description: "wide" }).description,
    ).toBe("wide");
  });
});
