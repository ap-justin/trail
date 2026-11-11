import { beforeAll, expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

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
});

const search = async (q: string) => {
  const res = await request(
    "GET",
    `/api/web/search?q=${encodeURIComponent(q)}`,
    { key: null, cookie },
  );
  return { status: res.status, body: (await res.json()) as Body };
};

test("finds visible issues by title and visible projects by name, and nothing in a hidden project", async () => {
  const { status, body } = await search("rocket");
  expect(status).toBe(200);
  expect(body).toEqual({
    issues: [
      {
        key: `${visible.key}-1`,
        sourceKey: null,
        title: "Fuel the rocket",
        status: "open",
        project: { key: visible.key, name: "Rocket launch" },
      },
    ],
    projects: [{ key: visible.key, name: "Rocket launch" }],
  });
});

test("finds an issue by its key and a project by its key", async () => {
  const { body } = await search(`${visible.key.toLowerCase()}-3`);
  expect(body.issues.map((i: Body) => i.title)).toEqual(["Paint"]);
  const byProjectKey = await search(visible.key);
  expect(byProjectKey.body.projects).toEqual([
    { key: visible.key, name: "Rocket launch" },
  ]);
  const hiddenKey = await search(hidden.key);
  expect(hiddenKey.body).toEqual({ issues: [], projects: [] });
});

test("matches % and _ literally", async () => {
  expect((await search("%")).body.issues.map((i: Body) => i.title)).toEqual([
    "100% done_ish",
  ]);
  expect((await search("F_el")).body.issues).toEqual([]);
});

test("an empty query is a 422", async () => {
  expect((await search(" ")).status).toBe(422);
});
