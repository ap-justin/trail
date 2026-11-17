import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { createEventBus } from "../events/bus.js";
import { testWebhooks } from "../test-app.js";
import {
  ForbiddenError,
  ForbiddenScopeError,
  IdempotencyKeyReusedError,
  NotFoundError,
  ValidationError,
} from "./errors.js";
import { createService } from "./index.js";
import { authenticateKey, createBot, type KeyScopeInput } from "./keys.js";

const dir = mkdtempSync(join(tmpdir(), "trail-project-filing-"));
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

// the operator's unrestricted bot seeds everything and owns every product
const admin = createBot(db, "admin").actor;

/** A bot acting through a key minted with `scope`. */
function keyed(name: string, scope: KeyScopeInput) {
  const { key } = createBot(db, name, { scope });
  const actor = authenticateKey(db, key);
  if (!actor) throw new Error("minted key did not authenticate");
  return actor;
}

for (const key of ["ATL", "BTA", "CTX"]) {
  service.createProduct(admin, { key, name: `Product ${key}` });
}
service.createLabel(admin, { productId: "BTA", name: "bug" });
const todo = (product: string, title: string) =>
  service.addTodo(admin, { product, title }).key;
const atlIn = todo("ATL", "atl in recon");
todo("ATL", "atl outside");
const btaIn = todo("BTA", "bta in recon");
const btaOut = todo("BTA", "bta outside");
service.createProject(admin, {
  name: "Recon",
  slug: "recon",
  products: ["ATL", "BTA"],
});
service.createProject(admin, { name: "Solo", slug: "solo", products: ["BTA"] });
service.addToProject(admin, "recon", [atlIn, btaIn]);

const alpha = keyed("alpha", { projects: ["recon"] });
const itemCount = () => service.listItems(admin, { limit: 200 }).items.length;

describe("a key naming one project files issues into it", () => {
  test("with project, the issue is in the product's triage and in the project, visible to the filer while other items stay 404", () => {
    const filed = service.fileIssue(alpha, {
      product: "BTA",
      project: "recon",
      title: "found a gap",
    });
    expect(filed.productKey).toBe("BTA");
    expect(filed.status).toBe("triage");
    expect(filed.projects.map((p) => p.slug)).toEqual(["recon"]);
    expect(service.getItem(alpha, filed.key).title).toBe("found a gap");
    expect(
      service.listItems(alpha, { project: "recon" }).items.map((i) => i.key),
    ).toContain(filed.key);
    expect(() => service.getItem(alpha, btaOut)).toThrow(NotFoundError);
  });

  test("the filing writes the created event and the project's add event, the add as add_to_project writes it", () => {
    const filed = service.fileIssue(alpha, {
      product: "ATL",
      project: "recon",
      title: "evented",
    });
    const recon = service.getProject(admin, "recon").id;
    const events = service
      .listActivity(admin, { limit: 200 })
      .items.filter((e) => e.subjectId === filed.id)
      .reverse();
    expect(events.map((e) => e.action)).toEqual([
      "issue.created",
      "project.item_added",
    ]);
    const added = events[1];
    expect(added).toMatchObject({
      actorId: alpha.id,
      subjectType: "issue",
      productKey: "ATL",
      projectId: recon,
      payload: { project: "recon", key: filed.key },
    });
    const later = service.addTodo(admin, { product: "ATL", title: "added" });
    service.addToProject(admin, "recon", [later.key]);
    const viaAdd = service
      .listActivity(admin, { limit: 1 })
      .items.find((e) => e.subjectId === later.id);
    expect(Object.keys(viaAdd?.payload ?? {}).sort()).toEqual(
      Object.keys(added?.payload ?? {}).sort(),
    );
    expect(events[0]?.payload).not.toHaveProperty("projects");
  });

  test("without project, the issue joins the key's one project", () => {
    const filed = service.fileIssue(alpha, { product: "BTA", title: "dflt" });
    expect(filed.status).toBe("triage");
    expect(filed.projects.map((p) => p.slug)).toEqual(["recon"]);
  });

  test("with project and no product, a project drawing from several products asks for one by key", () => {
    expect(() =>
      service.fileIssue(alpha, { project: "recon", title: "which" }),
    ).toThrow(
      new ValidationError(
        "project recon draws from ATL and BTA, so file_issue needs product: send product with one of them",
      ),
    );
  });

  test("a product the key reaches only through its project is named as such, and the call to make instead", () => {
    expect(() =>
      service.createStatusUpdate(alpha, {
        product: "BTA",
        body: "x",
        health: "on_track",
      }),
    ).toThrow(
      new NotFoundError(
        'this key reaches product BTA only through project recon: send project: "recon" in place of product (file_issue takes both, to file into BTA within the project); anything else on BTA itself needs a key that lists BTA',
      ),
    );
  });
});

describe("a key naming two projects", () => {
  const beta = keyed("beta", { projects: ["recon", "solo"] });

  test("must send project, and the refusal names the projects to resend with", () => {
    expect(() =>
      service.fileIssue(beta, { product: "BTA", title: "where" }),
    ).toThrow(
      new ValidationError(
        'this key reaches product BTA only through projects recon and solo, so file_issue needs project: resend with project: "recon" or project: "solo"',
      ),
    );
    expect(() =>
      service.fileIssue(beta, { product: "ATL", title: "where" }),
    ).toThrow(
      'only through project recon, so file_issue needs project: resend with project: "recon"',
    );
  });

  test("files into a project drawing from one product with project alone", () => {
    const filed = service.fileIssue(beta, { project: "solo", title: "solo" });
    expect(filed.productKey).toBe("BTA");
    expect(filed.projects.map((p) => p.slug)).toEqual(["solo"]);
  });

  test("a product the project does not draw from is refused, naming those it does", () => {
    expect(() =>
      service.fileIssue(beta, {
        product: "ATL",
        project: "solo",
        title: "wrong",
      }),
    ).toThrow(
      new ValidationError(
        "project solo draws from BTA, not ATL: send product with BTA, or a project that draws from ATL (list_projects shows each one's products)",
      ),
    );
  });
});

describe("a key with a product grant", () => {
  const gamma = keyed("gamma", { products: ["BTA"] });
  service.createProject(admin, {
    name: "Atlas",
    slug: "atlas",
    products: ["ATL"],
  });

  test("files without project as before, in no project", () => {
    const filed = service.fileIssue(gamma, { product: "BTA", title: "plain" });
    expect(filed.status).toBe("triage");
    expect(filed.projects).toEqual([]);
  });

  test("files into a project drawing from its product, the projects add_to_project lets it add to", () => {
    const filed = service.fileIssue(gamma, {
      product: "BTA",
      project: "recon",
      title: "joined",
    });
    expect(filed.projects.map((p) => p.slug)).toEqual(["recon"]);
  });

  test("files nothing on a product of that project it has no grant on, which it reads only through the project", () => {
    const before = itemCount();
    expect(() =>
      service.fileIssue(gamma, {
        product: "ATL",
        project: "recon",
        title: "no",
      }),
    ).toThrow(
      new ForbiddenScopeError(
        'this key reads product ATL only through project recon, which lets it read recon\'s ATL items and comment on them and file nothing on ATL: file on BTA (with project: "recon" to put the issue in recon), or get a key that lists product ATL or project recon. Ask admin, the owner of ATL, for that grant.',
      ),
    );
    expect(itemCount()).toBe(before);
  });

  test("files nothing into a project it does not reach, which reads as a project that does not exist", () => {
    const before = itemCount();
    const refusal = (slug: string) => {
      try {
        service.fileIssue(gamma, {
          product: "BTA",
          project: slug,
          title: "no",
        });
      } catch (error) {
        return error;
      }
    };
    const hidden = refusal("atlas");
    expect(hidden).toBeInstanceOf(NotFoundError);
    expect((hidden as Error).message).toBe(
      "no project atlas: pass the slug (like launch-q4) of a project this key reaches; list_projects (GET /api/v1/projects) lists them",
    );
    expect((refusal("nowhere") as Error).message).toBe(
      (hidden as Error).message.replace("atlas", "nowhere"),
    );
    expect(itemCount()).toBe(before);
  });

  test("with a project as well, a product reached only through it defaults to that project, and its granted product to none", () => {
    const delta = keyed("delta", { products: ["ATL"], projects: ["solo"] });
    expect(
      service
        .fileIssue(delta, { product: "BTA", title: "via solo" })
        .projects.map((p) => p.slug),
    ).toEqual(["solo"]);
    expect(
      service.fileIssue(delta, { product: "ATL", title: "own" }).projects,
    ).toEqual([]);
  });

  test("with a project as well, files a product reached only through that project into it alone, not into another project drawing from it", () => {
    const epsilon = keyed("epsilon", {
      products: ["ATL"],
      projects: ["solo"],
    });
    const before = itemCount();
    let refusal: unknown;
    try {
      service.fileIssue(epsilon, {
        product: "BTA",
        project: "recon",
        title: "through someone else's project",
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ValidationError);
    expect((refusal as Error).message).toBe(
      'this key files on product BTA only through project solo, not project recon: send project: "solo" with product BTA, or send product with ATL and project recon',
    );
    expect(itemCount()).toBe(before);
    expect(
      service.fileIssue(epsilon, {
        product: "ATL",
        project: "recon",
        title: "own product, their project",
      }).projects,
    ).toMatchObject([{ slug: "recon" }]);
  });

  test("asked for a product, names only the products of the project it may file on, and counts the rest", () => {
    expect(() =>
      service.fileIssue(gamma, { project: "recon", title: "which" }),
    ).toThrow(
      new ValidationError(
        "project recon draws from BTA and 1 other product, so file_issue needs product: send product with BTA",
      ),
    );
    const zeta = keyed("zeta", { products: ["BTA", "CTX"] });
    expect(() =>
      service.fileIssue(zeta, {
        product: "CTX",
        project: "recon",
        title: "not drawn",
      }),
    ).toThrow(
      new ValidationError(
        "project recon draws from BTA and 1 other product, not CTX: send product with BTA, or a project that draws from CTX (list_projects shows each one's products)",
      ),
    );
  });
});

describe("an unrestricted key", () => {
  const wide = keyed("wide", {});

  test("files with or without project as any product allows", () => {
    expect(
      service.fileIssue(wide, { product: "CTX", title: "free" }).projects,
    ).toEqual([]);
    expect(
      service
        .fileIssue(wide, { product: "ATL", project: "recon", title: "in" })
        .projects.map((p) => p.slug),
    ).toEqual(["recon"]);
  });
});

describe("a project-only bot is a non-owner bot on the products it files into", () => {
  const filed = () =>
    service.fileIssue(alpha, { product: "BTA", title: "mine" }).key;

  test("cannot accept triage, add a todo, change a type or create a label", () => {
    const key = filed();
    expect(() =>
      service.updateItem(alpha, key, { status: "open", assigneeId: alpha.id }),
    ).toThrow(
      `${key} is in the triage of BTA, which admin owns: only admin accepts or cancels it`,
    );
    expect(() => service.updateItem(alpha, btaIn, { type: "issue" })).toThrow(
      new ForbiddenError(
        "only admin, the owner of BTA, changes an item's type between todo and issue: comment on BTA-1 with add_comment to ask admin",
      ),
    );
    expect(() =>
      service.addTodo(alpha, { product: "BTA", title: "todo" }),
    ).toThrow("this key reaches product BTA only through project recon");
    const before = itemCount();
    expect(() =>
      service.addTodo(alpha, { product: "BTA", project: "recon", title: "t" }),
    ).toThrow(
      new ValidationError(
        "add_todo takes no project: add the todo without it, then add it to the project with add_to_project (POST /projects/{slug}/items); file_issue (type issue) is what takes project",
      ),
    );
    expect(itemCount()).toBe(before);
    expect(() =>
      service.createLabel(alpha, { productId: "BTA", name: "fresh" }),
    ).toThrow("this key reaches product BTA only through project recon");
  });

  test("attaches only the product's existing labels when filing", () => {
    const issue = service.fileIssue(alpha, {
      product: "BTA",
      title: "labelled",
      labels: ["Bug", "fresh"],
    });
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.skippedLabels).toEqual(["fresh"]);
  });

  test("moves an item assigned to it to in_progress, then done", () => {
    const key = filed();
    service.updateItem(admin, key, { status: "open", assigneeId: alpha.id });
    expect(
      service.updateItem(alpha, key, { status: "in_progress" }).status,
    ).toBe("in_progress");
    expect(service.updateItem(alpha, key, { status: "done" }).status).toBe(
      "done",
    );
  });

  test("cancels what it filed", () => {
    expect(
      service.updateItem(alpha, filed(), { status: "canceled" }).status,
    ).toBe("canceled");
  });

  test("posts a status update on its project", () => {
    expect(
      service.createStatusUpdate(alpha, {
        project: "recon",
        body: "filed two",
        health: "on_track",
      }).projectSlug,
    ).toBe("recon");
  });
});

describe("an idempotent filing into a project", () => {
  test("replays the whole result and writes the item, its membership and its events once", () => {
    const send = () =>
      service.fileIssue(
        alpha,
        { product: "BTA", project: "recon", title: "once" },
        { idempotencyKey: "file-once" },
      );
    const first = send();
    const again = send();
    expect(again).toEqual(first);
    expect(
      service
        .listItems(alpha, { project: "recon", limit: 200 })
        .items.filter((i) => i.title === "once"),
    ).toHaveLength(1);
    expect(
      service
        .listActivity(admin, { limit: 200 })
        .items.filter((e) => e.subjectId === first.id)
        .map((e) => e.action)
        .sort(),
    ).toEqual(["issue.created", "project.item_added"]);
    expect(() =>
      service.fileIssue(
        alpha,
        { product: "BTA", title: "once" },
        { idempotencyKey: "file-once" },
      ),
    ).toThrow(IdempotencyKeyReusedError);
  });
});

describe("a filing into a project that fails after the item is written", () => {
  test("leaves no item, membership or event behind, and the same filing goes through once the failure is gone", () => {
    const file = () =>
      service.fileIssue(alpha, {
        product: "BTA",
        project: "recon",
        title: "rolled back",
      });
    const events = () =>
      service.listActivity(admin, { limit: 200 }).items.length;
    const [items, logged] = [itemCount(), events()];
    // a real failure at the membership insert, after the item row is in
    db.$client.exec(
      "CREATE TRIGGER fail_membership BEFORE INSERT ON project_item BEGIN SELECT RAISE(ABORT, 'membership insert refused'); END",
    );
    try {
      expect(file).toThrow("membership insert refused");
    } finally {
      db.$client.exec("DROP TRIGGER fail_membership");
    }
    expect(itemCount()).toBe(items);
    expect(events()).toBe(logged);
    expect(file().projects.map((p) => p.slug)).toEqual(["recon"]);
    expect(itemCount()).toBe(items + 1);
  });
});

describe("a product key sent as project", () => {
  test("gets the hint to send it as product", () => {
    expect(() =>
      service.fileIssue(alpha, { project: "BTA", title: "mixed up" }),
    ).toThrow(
      new NotFoundError(
        'no project BTA: that is a product key, send it as product (product: "BTA")',
      ),
    );
  });
});
