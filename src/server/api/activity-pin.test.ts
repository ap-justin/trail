import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const { request, bot, addBot } = setupTestApp();

// The bots' contract: the human feed reads these payloads, and must never reshape them.
test("an issue.updated event reads on /api/v1/activity exactly as bots have always seen it", async () => {
  const project = (await (
    await request("POST", "/api/v1/projects", {
      json: { key: "PIN", name: "Pinned" },
    })
  ).json()) as { id: string };
  const issue = (await (
    await request("POST", "/api/v1/issues", {
      json: {
        projectId: project.id,
        title: "Pinned",
        labels: ["old"],
        links: [{ url: "https://example.com/a", title: "a" }],
      },
    })
  ).json()) as { id: string };
  const worker = addBot("worker");
  const patched = await request("PATCH", `/api/v1/issues/${issue.id}`, {
    json: {
      title: "Pinned down",
      status: "in_progress",
      priority: 2,
      assigneeId: worker.actor.id,
      estimate: 1.5,
      labels: ["new"],
      links: [{ url: "https://example.com/b" }],
    },
  });
  expect(patched.status).toBe(200);

  const res = await request(
    "GET",
    `/api/v1/activity?projectId=${project.id}&limit=1`,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toStrictEqual({
    items: [
      {
        id: expect.any(String),
        actorId: bot.actor.id,
        subjectType: "issue",
        subjectId: issue.id,
        projectId: project.id,
        action: "issue.updated",
        payload: {
          title: { from: "Pinned", to: "Pinned down" },
          status: { from: "open", to: "in_progress" },
          assigneeId: { from: null, to: worker.actor.id },
          estimate: { from: null, to: 1.5 },
          priority: { from: 0, to: 2 },
          labels: { from: ["old"], to: ["new"] },
          links: {
            from: [{ url: "https://example.com/a", title: "a" }],
            to: [
              { url: "https://example.com/b", title: "https://example.com/b" },
            ],
          },
        },
        createdAt: expect.any(String),
      },
    ],
    nextCursor: expect.any(String),
  });
});
