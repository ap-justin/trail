import { beforeAll, expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import { webSeed } from "./test-seed.js";

const { request, addMember, addProject } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = any;

const visible = addProject("Rocket launch");
const hidden = addProject("Rocket secret");
let cookie = "";

const file = (projectId: string, title: string) =>
  request("POST", "/api/v1/issues", { json: { projectId, title } });

beforeAll(async () => {
  cookie = await addMember("searcher", [visible.id]);
  await file(visible.id, "Fuel the rocket");
  await file(visible.id, "100% done_ish");
  await file(visible.id, "Paint");
  await file(hidden.id, "Rocket blueprint");
  const seed = webSeed(request);
  await seed.project("Rocket road", [visible.key, hidden.key]);
  await seed.project("Rocket vault", [hidden.key]);
  await seed.project("Moonshot", [visible.key], [], { slug: "rocket-moon" });
});

const search = async (q: string) => {
  const res = await request(
    "GET",
    `/api/web/search?q=${encodeURIComponent(q)}`,
    { key: null, cookie },
  );
  return { status: res.status, body: (await res.json()) as Body };
};

test("finds visible items by title, visible products by name and visible projects by name or slug, and nothing of a hidden product", async () => {
  const { status, body } = await search("rocket");
  expect(status).toBe(200);
  expect(body).toEqual({
    items: [
      {
        key: `${visible.key}-1`,
        sourceKey: null,
        title: "Fuel the rocket",
        type: "issue",
        status: "triage",
        product: { key: visible.key, name: "Rocket launch" },
      },
    ],
    products: [{ key: visible.key, name: "Rocket launch" }],
    projects: [
      { slug: "rocket-moon", name: "Moonshot" },
      { slug: "rocket-road", name: "Rocket road" },
    ],
  });
});

test("finds an item by its key and a product by its key", async () => {
  const { body } = await search(`${visible.key.toLowerCase()}-3`);
  expect(body.items.map((i: Body) => i.title)).toEqual(["Paint"]);
  const byProductKey = await search(visible.key);
  expect(byProductKey.body.products).toEqual([
    { key: visible.key, name: "Rocket launch" },
  ]);
  const hiddenKey = await search(hidden.key);
  expect(hiddenKey.body).toEqual({ items: [], products: [], projects: [] });
});

test("matches % and _ literally", async () => {
  expect((await search("%")).body.items.map((i: Body) => i.title)).toEqual([
    "100% done_ish",
  ]);
  expect((await search("F_el")).body.items).toEqual([]);
});

test("an empty query is a 422", async () => {
  expect((await search(" ")).status).toBe(422);
});

test("an item whose key is the query comes first, ahead of the 20 newest items whose keys only contain it", async () => {
  const many = addProject("Many items");
  const reader = await addMember("exact-searcher", [many.id]);
  for (let n = 1; n <= 120; n++) await file(many.id, `item ${n}`);
  const res = await request(
    "GET",
    `/api/web/search?q=${encodeURIComponent(`${many.key.toLowerCase()}-1`)}`,
    { key: null, cookie: reader },
  );
  const { items } = (await res.json()) as Body;
  expect(items).toHaveLength(20);
  expect(items[0]).toMatchObject({ key: `${many.key}-1`, title: "item 1" });
});
