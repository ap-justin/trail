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

test.each([
  "@octo-cat",
  " octo-cat",
  "octo--cat",
  "-octo",
  "octo_cat",
  "a".repeat(40),
])("TRAIL_OWNER_GITHUB must be a GitHub username: %j is refused", (value) => {
  expect(() => loadConfig({ ...required, TRAIL_OWNER_GITHUB: value })).toThrow(
    "TRAIL_OWNER_GITHUB",
  );
});

const github = {
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
  BETTER_AUTH_URL: "https://trail.example",
};

test("GitHub sign-in is on only with its credentials and BETTER_AUTH_URL", () => {
  expect(loadConfig({ ...required, ...github }).github).toEqual({
    clientId: "id",
    clientSecret: "secret",
  });
  expect(
    loadConfig({ ...required, ...github, BETTER_AUTH_URL: undefined }).github,
  ).toEqual({ missing: ["BETTER_AUTH_URL"] });
  expect(
    loadConfig({ ...required, ...github, GITHUB_CLIENT_SECRET: "" }).github,
  ).toEqual({ missing: ["GITHUB_CLIENT_SECRET"] });
  expect(loadConfig(required).github).toEqual({
    missing: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "BETTER_AUTH_URL"],
  });
});

const email = {
  EMAIL_FROM: "trail <trail@mail.example>",
  RESEND_API_KEY: "re_test",
  BETTER_AUTH_URL: "https://trail.example",
};

test("email sign-in is on only with a sender, a Resend key and BETTER_AUTH_URL", () => {
  expect(loadConfig({ ...required, ...email }).email).toEqual({
    from: "trail <trail@mail.example>",
    resendApiKey: "re_test",
  });
  expect(
    loadConfig({ ...required, ...email, RESEND_API_KEY: "" }).email,
  ).toEqual({ missing: ["RESEND_API_KEY"] });
  expect(loadConfig(required).email).toEqual({
    missing: ["EMAIL_FROM", "RESEND_API_KEY", "BETTER_AUTH_URL"],
  });
});

test("the CLI and db:migrate need only the database path", () => {
  expect(loadDatabaseConfig({}).DATABASE_PATH).toBe("./data/trail.db");
});

test("PORT defaults to 3000 and takes a port number", () => {
  expect(loadConfig(required).PORT).toBe(3000);
  expect(loadConfig({ ...required, PORT: "8080" }).PORT).toBe(8080);
});

test.each(["", " ", "abc", "80a", "1.5", "-1", "65536"])(
  "the server refuses to start with PORT=%j",
  (value) => {
    expect(() => loadConfig({ ...required, PORT: value })).toThrow("PORT");
  },
);
