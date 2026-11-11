import { expect, test } from "vitest";
import { loadConfig, loadDatabaseConfig } from "./config.js";

const required = {
  TRAIL_OWNER_GITHUB: "Octo-Cat",
  BETTER_AUTH_SECRET: "s".repeat(32),
};

test.each(Object.keys(required))(
  "the server refuses to start without %s",
  (name) => {
    const env: NodeJS.ProcessEnv = { ...required };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(name);
  },
);

test("the owner's GitHub username is held lowercased", () => {
  expect(loadConfig(required).TRAIL_OWNER_GITHUB).toBe("octo-cat");
});

test("GitHub OAuth is absent unless both its variables are set", () => {
  expect(loadConfig({ ...required, GITHUB_CLIENT_ID: "id" }).github).toEqual({
    missing: ["GITHUB_CLIENT_SECRET"],
  });
  expect(
    loadConfig({
      ...required,
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
    }).github,
  ).toEqual({ clientId: "id", clientSecret: "secret" });
});

test("the CLI and db:migrate need only the database path", () => {
  expect(loadDatabaseConfig({}).DATABASE_PATH).toBe("./data/trail.db");
});
