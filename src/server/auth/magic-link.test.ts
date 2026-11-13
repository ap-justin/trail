import { afterEach, expect, test, vi } from "vitest";
import { sessionCookie, setupTestApp } from "../test-app.js";

const {
  mail,
  requestEmailLink,
  deliveries,
  inviteEmail,
  linkSentTo,
  openLink,
  viewerOf,
} = setupTestApp();

test("an invited address is emailed a sign-in link from EMAIL_FROM", async () => {
  inviteEmail("dana@example.com");
  const res = await requestEmailLink("dana@example.com");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: true });
  await deliveries();
  expect(mail).toHaveLength(1);
  const [sent] = mail;
  expect(sent).toMatchObject({
    from: "trail <trail@mail.example.test>",
    to: "dana@example.com",
    subject: "Your trail sign-in link",
  });
  const link = new URL(sent?.text.match(/https?:\/\/\S+/)?.[0] ?? "");
  expect(link.origin + link.pathname).toBe(
    "http://localhost/api/auth/magic-link/verify",
  );
  expect(link.searchParams.get("token")).toMatch(/^[A-Za-z0-9]{32}$/);
  expect(link.searchParams.get("callbackURL")).toBe("/");
  expect(link.searchParams.get("errorCallbackURL")).toBe("/sign-in");
});

test("an address no invite names gets the same answer, and no email", async () => {
  inviteEmail("erin@example.com");
  const invited = await requestEmailLink("erin@example.com");
  const stranger = await requestEmailLink("mallory@example.com");
  expect(stranger.status).toBe(invited.status);
  expect(await stranger.text()).toBe(await invited.text());
  expect([...stranger.headers.keys()]).toEqual([...invited.headers.keys()]);
  await deliveries();
  expect(mail.map((m) => m.to)).not.toContain("mallory@example.com");
});

test("the address is matched trimmed and ignoring case", async () => {
  inviteEmail("frank@example.com");
  expect((await requestEmailLink("  Frank@Example.COM ")).status).toBe(200);
  await deliveries();
  expect(mail.at(-1)?.to).toBe("frank@example.com");
});

test.each([["not-an-email"], [""], ["devon-r"]])(
  "a link for %j is refused as not an email address",
  async (entry) => {
    const res = await requestEmailLink(entry);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "invalid_email" },
    });
  },
);

afterEach(() => {
  vi.useRealTimers();
});

const rateLimited = async (res: Response) => {
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({
    error: { code: "rate_limited", message: expect.any(String) },
  });
  return Number(res.headers.get("retry-after"));
};

test("an address gets 3 links per 15 minutes, invited or not, from any IP", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  inviteEmail("gail@example.com");
  for (const address of ["gail@example.com", "nobody@example.com"]) {
    for (let i = 0; i < 3; i++) {
      expect((await requestEmailLink(address)).status).toBe(200);
    }
    const wait = await rateLimited(await requestEmailLink(address));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(15 * 60);
  }
  await deliveries();
  expect(mail.filter((m) => m.to === "gail@example.com")).toHaveLength(3);

  vi.setSystemTime(Date.now() + 15 * 60_000);
  expect((await requestEmailLink("gail@example.com")).status).toBe(200);
});

test("an IP gets 10 links per 15 minutes, across addresses", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const ip = "203.0.113.7";
  for (let i = 0; i < 10; i++) {
    const res = await requestEmailLink(`spray${i}@example.com`, { ip });
    expect(res.status).toBe(200);
  }
  await rateLimited(await requestEmailLink("spray10@example.com", { ip }));
  // another IP is unaffected
  expect((await requestEmailLink("spray10@example.com")).status).toBe(200);

  vi.setSystemTime(Date.now() + 15 * 60_000);
  expect((await requestEmailLink("spray11@example.com", { ip })).status).toBe(
    200,
  );
});

/** Asks for a link for `address`, invited, and returns the link emailed. */
async function freshLink(address: string) {
  inviteEmail(address);
  expect((await requestEmailLink(address)).status).toBe(200);
  await deliveries();
  return linkSentTo(address);
}

const landsOnSignInWith = (res: Response, error: string) => {
  expect(res.status).toBe(302);
  const to = new URL(res.headers.get("location") ?? "", "http://localhost");
  expect(to.pathname).toBe("/sign-in");
  expect(to.searchParams.get("error")).toBe(error);
  expect(sessionCookie(res)).toBe("");
};

test("a link signs in once, then lands on /sign-in?error=INVALID_TOKEN", async () => {
  const link = await freshLink("hana@example.com");
  const first = await openLink(link);
  expect(first.status).toBe(302);
  expect(first.headers.get("location")).toBe("http://localhost/");
  expect(await viewerOf(sessionCookie(first))).toMatchObject({
    kind: "member",
  });
  landsOnSignInWith(await openLink(link), "INVALID_TOKEN");
});

test("a link past 15 minutes lands on /sign-in?error=INVALID_TOKEN", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const link = await freshLink("ivan@example.com");
  vi.setSystemTime(Date.now() + 15 * 60_000 + 1_000);
  landsOnSignInWith(await openLink(link), "INVALID_TOKEN");
});

test("a link 14 minutes old still signs in", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const link = await freshLink("jo@example.com");
  vi.setSystemTime(Date.now() + 14 * 60_000);
  expect(sessionCookie(await openLink(link))).not.toBe("");
});

test("a made-up or altered token lands on /sign-in?error=INVALID_TOKEN", async () => {
  const link = new URL(await freshLink("kai@example.com"));
  link.searchParams.set("token", `${link.searchParams.get("token")}x`);
  landsOnSignInWith(await openLink(link.toString()), "INVALID_TOKEN");
});
