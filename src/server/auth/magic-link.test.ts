import { afterEach, expect, test, vi } from "vitest";
import { sessionCookie, setupTestApp } from "../test-app.js";

const {
  app,
  mail,
  requestEmailLink,
  deliveries,
  inviteEmail,
  linkSentTo,
  openLink,
  confirmLink,
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
  expect(link.origin + link.pathname).toBe("http://localhost/sign-in/confirm");
  expect([...link.searchParams.keys()]).toEqual(["token", "callbackURL"]);
  expect(sent?.html).toContain(
    `href="${link.toString().replaceAll("&", "&amp;")}"`,
  );
  expect(link.searchParams.get("token")).toMatch(/^[A-Za-z0-9]{32}$/);
  expect(link.searchParams.get("callbackURL")).toBe("/");
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

test("an address gets 3 links per 15 minutes from one IP, invited or not", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  inviteEmail("gail@example.com");
  const ip = "203.0.113.20";
  for (const address of ["gail@example.com", "nobody@example.com"]) {
    for (let i = 0; i < 3; i++) {
      expect((await requestEmailLink(address, { ip })).status).toBe(200);
    }
    const limited = await requestEmailLink(address, { ip });
    expect(await rateLimited(limited)).toBe(15 * 60);
  }
  // the same address from another IP is not held back by that IP's count
  expect((await requestEmailLink("gail@example.com")).status).toBe(200);
  await deliveries();
  expect(mail.filter((m) => m.to === "gail@example.com")).toHaveLength(4);

  vi.setSystemTime(Date.now() + 15 * 60_000);
  expect((await requestEmailLink("gail@example.com", { ip })).status).toBe(200);
});

test("an address gets 10 links an hour across all IPs, invited or not", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  inviteEmail("hugo@example.com");
  for (const address of ["hugo@example.com", "ghost@example.com"]) {
    for (let i = 0; i < 10; i++) {
      expect((await requestEmailLink(address)).status).toBe(200);
    }
    expect(await rateLimited(await requestEmailLink(address))).toBe(60 * 60);
  }
  vi.setSystemTime(Date.now() + 60 * 60_000);
  expect((await requestEmailLink("hugo@example.com")).status).toBe(200);
});

test("the rate-limited message counts the minutes Retry-After gives", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const ip = "203.0.113.21";
  for (let i = 0; i < 3; i++)
    await requestEmailLink("iris@example.com", { ip });
  const message = async () => {
    const res = await requestEmailLink("iris@example.com", { ip });
    const wait = Number(res.headers.get("retry-after"));
    const { error } = (await res.json()) as { error: { message: string } };
    return { wait, message: error.message };
  };
  expect(await message()).toEqual({
    wait: 900,
    message: "too many sign-in links asked for: try again in 15 minutes",
  });
  vi.setSystemTime(Date.now() + 14 * 60_000 + 30_000);
  expect(await message()).toEqual({
    wait: 30,
    message: "too many sign-in links asked for: try again in 1 minute",
  });
});

test("asking for a link from another site's page is refused", async () => {
  inviteEmail("jade@example.com");
  const res = await app.request("/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "jade@example.com" }),
  });
  expect(res.status).toBe(403);
  await deliveries();
  expect(mail.map((m) => m.to)).not.toContain("jade@example.com");
});

test.each([
  ["/api/auth/sign-in//magic-link", 1],
  ["/api/auth/Sign-In/Magic-Link", 2],
  ["/api/auth/sign-in/magic-link/", 3],
  ["/api/auth/sign-in%2Fmagic-link", 4],
  ["/api/auth/sign-in/magic%2Dlink", 5],
])(
  "%s is trail's link request too, allowlist and limits included",
  async (path, n) => {
    const ip = `203.0.113.${40 + n}`;
    const ask = (email: string) =>
      app.request(path, {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "fly-client-ip": ip,
        },
        body: JSON.stringify({ email }),
      });
    const stranger = `variant${n}@example.com`;
    for (let i = 0; i < 3; i++) expect((await ask(stranger)).status).toBe(200);
    await rateLimited(await ask(stranger));
    await deliveries();
    expect(mail.map((m) => m.to)).not.toContain(stranger);
  },
);

/** Asks for a link for `address`, invited, and returns the link emailed. */
async function freshLink(address: string) {
  inviteEmail(address);
  expect((await requestEmailLink(address)).status).toBe(200);
  await deliveries();
  return linkSentTo(address);
}

const invalidToken = async (res: Response) => {
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: { code: "INVALID_TOKEN", message: expect.any(String) },
  });
  expect(sessionCookie(res)).toBe("");
};

test("confirming a link signs in once and says where to go; a second confirm is INVALID_TOKEN", async () => {
  const link = await freshLink("hana@example.com");
  const first = await confirmLink(link);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ redirectTo: "/" });
  expect(await viewerOf(sessionCookie(first))).toMatchObject({
    kind: "member",
  });
  await invalidToken(await confirmLink(link));
});

test("opening the link, or better-auth's verify URL, with a GET never uses the token up", async () => {
  const link = await freshLink("hal@example.com");
  const token = new URL(link).searchParams.get("token") ?? "";
  const page = await openLink(link);
  expect(sessionCookie(page)).toBe("");
  for (const path of [
    "/api/auth/magic-link/verify",
    "/api/auth//magic-link/verify/",
    "/api/auth/Magic-Link/verify",
    "/api/auth/magic-link%2Fverify",
  ]) {
    const res = await openLink(
      `${path}?token=${token}&callbackURL=%2Fprojects`,
    );
    expect(sessionCookie(res)).toBe("");
    if (path === "/api/auth/magic-link/verify") {
      expect(res.status).toBe(302);
      const to = new URL(res.headers.get("location") ?? "", "http://x");
      expect(to.pathname).toBe("/sign-in/confirm");
      expect(to.searchParams.get("token")).toBe(token);
      expect(to.searchParams.get("callbackURL")).toBe("/projects");
      // an older link carries no address, and the token is not read to find one
      expect(to.searchParams.has("email")).toBe(false);
    }
  }
  expect((await confirmLink(link)).status).toBe(200);
});

test("a confirm from another site's page is refused and leaves the link usable", async () => {
  const link = await freshLink("ida@example.com");
  for (const origin of ["https://evil.example", null]) {
    const res = await confirmLink(link, { origin });
    expect(res.status).toBe(403);
    expect(sessionCookie(res)).toBe("");
  }
  expect((await confirmLink(link)).status).toBe(200);
});

test("a link past 15 minutes is INVALID_TOKEN", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const link = await freshLink("ivan@example.com");
  vi.setSystemTime(Date.now() + 15 * 60_000 + 1_000);
  await invalidToken(await confirmLink(link));
});

test("a link 14 minutes old still signs in", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const link = await freshLink("jo@example.com");
  vi.setSystemTime(Date.now() + 14 * 60_000);
  expect(sessionCookie(await confirmLink(link))).not.toBe("");
});

test("the email in the link is for show: confirming signs in whoever the token is for", async () => {
  const link = new URL(await freshLink("lou@example.com"));
  link.searchParams.set("email", "someone-else@example.com");
  const res = await confirmLink(link.toString(), {
    email: "someone-else@example.com",
  });
  expect(res.status).toBe(200);
  expect(await viewerOf(sessionCookie(res))).toMatchObject({
    actor: { email: "lou@example.com" },
  });
});

test("a made-up or altered token is INVALID_TOKEN", async () => {
  const link = new URL(await freshLink("kai@example.com"));
  link.searchParams.set("token", `${link.searchParams.get("token")}x`);
  await invalidToken(await confirmLink(link.toString()));
});

test("the link returns to the path the person asked from", async () => {
  inviteEmail("kim@example.com");
  const path = "/projects/TRL?status=open#top";
  await requestEmailLink("kim@example.com", { callbackURL: path });
  await deliveries();
  const link = linkSentTo("kim@example.com");
  expect(new URL(link).searchParams.get("callbackURL")).toBe(path);
  expect(new URL(link).searchParams.has("email")).toBe(false);
  expect(await (await confirmLink(link)).json()).toEqual({ redirectTo: path });
});

let returns = 0;
test.each([
  "https://evil.example/",
  "//evil.example",
  "/\\evil.example",
  "/ /evil.example",
  "javascript:alert(1)",
  "projects",
])("a callbackURL of %j returns to /", async (callbackURL) => {
  const address = `ret${++returns}@example.com`;
  inviteEmail(address);
  await requestEmailLink(address, { callbackURL });
  await deliveries();
  const link = linkSentTo(address);
  expect(new URL(link).searchParams.get("callbackURL")).toBe("/");
  // and one altered in the link on its way to the confirm page
  const altered = new URL(link);
  altered.searchParams.set("callbackURL", callbackURL);
  expect(await (await confirmLink(altered.toString())).json()).toEqual({
    redirectTo: "/",
  });
});
