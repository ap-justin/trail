import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const {
  mail,
  request,
  requestEmailLink,
  deliveries,
  inviteEmail,
  signIn,
  owner,
} = setupTestApp({
  auth: { email: { missing: ["EMAIL_FROM", "RESEND_API_KEY"] } },
});

test("without email configured, asking for a link answers 503 naming what is missing, and sends nothing", async () => {
  inviteEmail("pia@example.com");
  const res = await requestEmailLink("pia@example.com");
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({
    error: {
      code: "sign_in_unavailable",
      message:
        "Email sign-in is not configured: set EMAIL_FROM and RESEND_API_KEY",
    },
  });
  await deliveries();
  expect(mail).toEqual([]);
});

test("without email configured, /me says email sign-in is off", async () => {
  const res = await request("GET", "/api/web/me", { key: null });
  expect(await res.json()).toMatchObject({ emailSignIn: false });
});

test("without email configured, GitHub sign-in still works", async () => {
  const cookie = await signIn(owner);
  const res = await request("GET", "/api/web/me", { key: null, cookie });
  expect(await res.json()).toMatchObject({ state: "owner", login: owner });
});
