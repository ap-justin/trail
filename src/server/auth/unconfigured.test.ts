import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const { app, request } = setupTestApp({
  auth: { github: { missing: ["GITHUB_CLIENT_SECRET"] } },
});

test.each([
  ["POST", "/api/auth/sign-in/social"],
  ["GET", "/api/auth/callback/github?code=c&state=s"],
])(
  "without GitHub OAuth configured, %s %s answers 503 naming the variable",
  async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      body:
        method === "POST"
          ? JSON.stringify({ provider: "github", callbackURL: "/" })
          : undefined,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "sign_in_unavailable",
        message: expect.stringContaining("GITHUB_CLIENT_SECRET"),
      },
    });
  },
);

test("without GitHub OAuth configured, bots still work", async () => {
  expect((await request("GET", "/api/v1/projects")).status).toBe(200);
});
