import { beforeAll, expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const { bot, request } = setupTestApp();

let issueId = "";
beforeAll(async () => {
  const project = await request("POST", "/api/v1/projects", {
    json: { name: "comments" },
  });
  const { id: projectId } = (await project.json()) as { id: string };
  const issue = await request("POST", "/api/v1/issues", {
    json: { projectId, title: "talk about it" },
  });
  issueId = ((await issue.json()) as { id: string }).id;
});

test("POST /issues/:id/comments adds a comment as the bot and returns 201", async () => {
  const res = await request("POST", `/api/v1/issues/${issueId}/comments`, {
    json: { body: "  looks good\n" },
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({
    id: expect.any(String),
    issueId,
    authorId: bot.actor.id,
    body: "  looks good\n",
    createdAt: expect.any(String),
  });
});

test("POST /issues/:id/comments on an unknown issue is a 404", async () => {
  const res = await request("POST", "/api/v1/issues/nope/comments", {
    json: { body: "hello?" },
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({
    error: { code: "not_found", message: "no issue nope" },
  });
});

test("POST /issues/:id/comments with a blank body is a 422", async () => {
  for (const body of ["", "   "]) {
    const res = await request("POST", `/api/v1/issues/${issueId}/comments`, {
      json: { body },
    });
    expect(res.status).toBe(422);
  }
});

test("GET /issues/:id/comments lists the thread oldest first, paged", async () => {
  for (const body of ["second", "third"]) {
    await request("POST", `/api/v1/issues/${issueId}/comments`, {
      json: { body },
    });
  }
  const first = await request(
    "GET",
    `/api/v1/issues/${issueId}/comments?limit=2`,
  );
  expect(first.status).toBe(200);
  const page = (await first.json()) as {
    items: { body: string }[];
    nextCursor: string;
  };
  expect(page.items.map((c) => c.body)).toEqual(["  looks good\n", "second"]);
  const rest = await request(
    "GET",
    `/api/v1/issues/${issueId}/comments?limit=2&cursor=${page.nextCursor}`,
  );
  expect(await rest.json()).toMatchObject({
    items: [{ body: "third" }],
    nextCursor: null,
  });
});

test("GET /issues/:id/comments on an unknown issue is a 404", async () => {
  expect((await request("GET", "/api/v1/issues/nope/comments")).status).toBe(
    404,
  );
});
