import { eq } from "drizzle-orm";
import { afterEach, expect, test, vi } from "vitest";
import { actor, invite, productMember } from "../db/schema.js";
import { createBot, setBotHandler } from "../service/keys.js";
import { setupTestApp, TEST_OWNER } from "../test-app.js";
import { verifiedPrimaryEmail } from "./github-email.js";

/** Holds GitHub's /user/emails answer until it resolves; each test that sets it clears it. */
let held: Promise<void> | null = null;
// email reads not yet stored; a read's store is done by the event-loop turn after its answer
let reading = 0;
/** Stands in for GitHub's /user/emails answer while set; afterEach clears it. */
let failing: (() => Promise<Response>) | null = null;
// the authorization header each read sent, so a test can look for its token in the logs
const sentAuth: string[] = [];
afterEach(() => {
  held = null;
  failing = null;
  sentAuth.length = 0;
  vi.restoreAllMocks();
});
const {
  db,
  bot,
  request,
  signIn: signInNow,
  inviteEmail,
  signInWithEmail,
} = setupTestApp({
  emailFetch: async (input, init) => {
    reading++;
    try {
      await held;
      sentAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      if (failing) return await failing();
      return await globalThis.fetch(input, init);
    } finally {
      setImmediate(() => reading--);
    }
  },
});

/** Signs in, then waits for the background read and store of the person's GitHub email. */
async function signIn(...args: Parameters<typeof signInNow>) {
  const cookie = await signInNow(...args);
  await vi.waitFor(() => expect(reading).toBe(0), { timeout: 5_000 });
  return cookie;
}

const verified = (email: string) => [{ email, primary: true, verified: true }];

function invitePerson(username: string) {
  db.insert(invite).values({ username, invitedBy: bot.actor.id }).run();
}

const stored = (githubId: number) =>
  db
    .select({ githubEmail: actor.githubEmail, email: actor.email })
    .from(actor)
    .where(eq(actor.githubId, githubId))
    .get();

test("a verified primary address is stored, lowercased, for a person let in", async () => {
  invitePerson("ada-store");
  await signIn("ada-store", {
    githubId: 7001,
    emails: [
      { email: "Other@example.com", primary: false, verified: true },
      { email: "Ada.Store@Example.com", primary: true, verified: true },
    ],
  });
  expect(stored(7001)).toEqual({
    githubEmail: "ada.store@example.com",
    email: null,
  });
});

test("sign-in returns while GitHub's emails are still on their way, and the address lands after", async () => {
  invitePerson("waiting-wes");
  let release = () => {};
  held = new Promise((resolve) => {
    release = resolve;
  });
  // were sign-in to await the read, this would hang until the test times out
  await signInNow("waiting-wes", {
    githubId: 7016,
    emails: verified("wes@example.com"),
  });
  held = null;
  expect(stored(7016)?.githubEmail).toBeNull();
  release();
  await expect
    .poll(() => stored(7016)?.githubEmail, { timeout: 5_000 })
    .toBe("wes@example.com");
});

test("an unverified primary address is never stored", async () => {
  invitePerson("unverified-pat");
  await signIn("unverified-pat", {
    githubId: 7002,
    emails: [{ email: "pat@example.com", primary: true, verified: false }],
  });
  expect(stored(7002)?.githubEmail).toBeNull();
});

test("a verified address that isn't primary is never stored", async () => {
  invitePerson("second-sid");
  await signIn("second-sid", {
    githubId: 7019,
    emails: [{ email: "sid@example.com", primary: false, verified: true }],
  });
  expect(stored(7019)?.githubEmail).toBeNull();
});

test("nothing is stored when GitHub lists no emails", async () => {
  invitePerson("empty-eli");
  await signIn("empty-eli", { githubId: 7003, emails: [] });
  expect(stored(7003)).toEqual({ githubEmail: null, email: null });
});

test("nothing is stored when GitHub refuses the token", async () => {
  invitePerson("scopeless-sam");
  await signIn("scopeless-sam", { githubId: 7004, emails: null });
  expect(stored(7004)).toEqual({ githubEmail: null, email: null });
});

test.each([
  [7005, "private-pip", "7005+private-pip@users.noreply.github.com"],
  [7020, "private-uma", "7020+Private-Uma@Users.NoReply.GitHub.com"],
])(
  "GitHub's private-address stand-in %s is never stored, in any case",
  async (githubId, login, address) => {
    invitePerson(login);
    await signIn(login, { githubId, emails: verified(address) });
    expect(stored(githubId)).toEqual({ githubEmail: null, email: null });
  },
);

test("an address GitHub accepts but trail's shape check refuses is not stored, with one warning, and sign-in goes on", async () => {
  invitePerson("odd-ott");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await signIn("odd-ott", {
    githubId: 7021,
    emails: verified("a b@example.com"),
  });
  expect(stored(7021)?.githubEmail).toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toMatch(
    /not an address trail accepts/,
  );
});

test("a person's stored address stays when their GitHub primary address changes", async () => {
  invitePerson("steady-sue");
  await signIn("steady-sue", {
    githubId: 7006,
    emails: verified("a@example.com"),
  });
  await signIn("steady-sue", {
    githubId: 7006,
    emails: verified("b@example.com"),
  });
  expect(stored(7006)?.githubEmail).toBe("a@example.com");
});

test("a person who signed in before it was stored gets the address on their next sign-in", async () => {
  invitePerson("late-lou");
  await signIn("late-lou", { githubId: 7007, emails: null });
  expect(stored(7007)?.githubEmail).toBeNull();
  await signIn("late-lou", {
    githubId: 7007,
    emails: verified("lou@example.com"),
  });
  expect(stored(7007)?.githubEmail).toBe("lou@example.com");
});

test("an address another person holds is refused once, and sign-in goes on", async () => {
  invitePerson("first-fay");
  invitePerson("second-gus");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await signIn("first-fay", {
    githubId: 7008,
    emails: verified("shared@example.com"),
  });
  await signIn("second-gus", {
    githubId: 7009,
    emails: verified("Shared@Example.com"),
  });
  const refusals = warn.mock.calls.filter(([m]) =>
    String(m).includes("not stored"),
  );
  expect(refusals).toHaveLength(1);
  expect(stored(7008)?.githubEmail).toBe("shared@example.com");
  expect(stored(7009)?.githubEmail).toBeNull();
});

test("an address an email invite's person holds is refused for a GitHub person", async () => {
  inviteEmail("held@example.com");
  await signInWithEmail("held@example.com");
  invitePerson("latecomer-ned");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await signIn("latecomer-ned", {
    githubId: 7010,
    emails: verified("held@example.com"),
  });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(stored(7010)?.githubEmail).toBeNull();
});

test("an address a pending email invite names is refused for a GitHub person, and the invitee still gets in", async () => {
  inviteEmail("pending@example.com");
  invitePerson("early-eve");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await signIn("early-eve", {
    githubId: 7022,
    emails: verified("Pending@Example.com"),
  });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(stored(7022)?.githubEmail).toBeNull();
  await signInWithEmail("pending@example.com");
  expect(
    db
      .select({ email: actor.email })
      .from(actor)
      .where(eq(actor.email, "pending@example.com"))
      .all(),
  ).toEqual([{ email: "pending@example.com" }]);
});

test("an invited address a GitHub person holds lets no second person in under it, and the warning names no address", async () => {
  invitePerson("holder-hal");
  await signIn("holder-hal", {
    githubId: 7011,
    emails: verified("taken@example.com"),
  });
  const inviteId = inviteEmail("taken@example.com");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await signInWithEmail("taken@example.com");
  expect(
    db.select().from(actor).where(eq(actor.email, "taken@example.com")).all(),
  ).toEqual([]);
  const messages = warn.mock.calls.map(([m]) => String(m));
  expect(messages.some((m) => m.includes(`invite ${inviteId}`))).toBe(true);
  expect(messages.filter((m) => m.includes("taken@example.com"))).toEqual([]);
});

test("a member who signed in with GitHub becomes a bot's handler by that address; a stranger or an unstored address is refused", async () => {
  invitePerson("handler-ivy");
  invitePerson("silent-jo");
  await signIn("handler-ivy", {
    githubId: 7012,
    emails: verified("ivy@example.com"),
  });
  await signIn("silent-jo", { githubId: 7013, emails: [] });
  const handled = createBot(db, "gh handled");
  const set = setBotHandler(db, handled.actor.id, "IVY@example.com");
  expect(set.to).toMatchObject({ email: "ivy@example.com" });
  expect(set.to?.name).toBeTruthy();
  const refusal = (address: string) =>
    `no trail member has the email ${address} on file. Someone who signs in with GitHub has an address on file once a sign-in reads their verified primary GitHub email; trail stores it only if they have none yet, it isn't a GitHub noreply address, and no other person or email invite has it. If all of that holds for ${address}, have them sign in to trail again, then set the handler; otherwise this address can't name them. For someone without GitHub, invite that address on trail's People page, then set the handler once they have signed in with it`;
  expect(() =>
    setBotHandler(db, handled.actor.id, "nobody@example.com"),
  ).toThrow(refusal("nobody@example.com"));
  expect(() =>
    setBotHandler(db, handled.actor.id, "silent-jo@example.com"),
  ).toThrow(refusal("silent-jo@example.com"));
});

test("the owner who signed in with GitHub can be a handler", async () => {
  await signIn(TEST_OWNER, { emails: verified("owner@example.com") });
  const handled = createBot(db, "owner handled");
  expect(
    setBotHandler(db, handled.actor.id, "owner@example.com").to,
  ).toMatchObject({
    email: "owner@example.com",
  });
});

test("a person whose invite was removed is refused by their address, naming the GitHub username to invite again", async () => {
  invitePerson("gone-kit");
  await signIn("gone-kit", {
    githubId: 7014,
    emails: verified("kit@example.com"),
  });
  db.delete(invite).where(eq(invite.username, "gone-kit")).run();
  const handled = createBot(db, "kit handled");
  const name = db
    .select({ name: actor.displayName })
    .from(actor)
    .where(eq(actor.githubId, 7014))
    .get()?.name;
  expect(() => setBotHandler(db, handled.actor.id, "kit@example.com")).toThrow(
    `kit@example.com is on file for ${name}, who signed in with GitHub but isn't a member now: if they aren't invited yet, invite @gone-kit on trail's People page; set the handler once they have signed in after the invite`,
  );
});

test("a GitHub handler's address reaches a bot only in its own whoami", async () => {
  const ADDRESS = "dana.gh@example.com";
  invitePerson("handler-dana");
  await signIn("handler-dana", { githubId: 7015, emails: verified(ADDRESS) });
  const dana = db.select().from(actor).where(eq(actor.githubId, 7015)).get();
  const handled = createBot(db, "gh sweep handled");
  const watcher = createBot(db, "gh sweep watcher");
  setBotHandler(db, handled.actor.id, ADDRESS);
  const body = async (
    method: string,
    path: string,
    key: string,
    json?: object,
  ) => {
    const res = await request(method, `/api/v1${path}`, { key, json });
    expect(res.status, `${method} ${path}`).toBeLessThan(300);
    return res.text();
  };
  const product = JSON.parse(
    await body("POST", "/products", bot.key, { key: "GHS", name: "gh sweep" }),
  ) as { id: string };
  const member = db
    .select()
    .from(invite)
    .where(eq(invite.githubId, 7015))
    .get();
  db.insert(productMember)
    .values({ inviteId: member?.id as number, productId: product.id })
    .run();
  const filed = await body("POST", "/items", handled.key, {
    type: "issue",
    product: "GHS",
    title: "for dana",
    filed_for: "handler",
  });
  const { key } = JSON.parse(filed) as { key: string };
  const read = [filed];
  for (const k of [handled.key, watcher.key, bot.key]) {
    read.push(
      await body("GET", `/items/${key}`, k),
      await body("GET", "/items?product=GHS", k),
      await body("GET", "/activity?product=GHS", k),
      await body("GET", "/bots?limit=100", k),
    );
  }
  read.push(
    await body("GET", "/whoami", watcher.key),
    await body("GET", "/whoami", bot.key),
  );
  expect(dana?.githubEmail).toBe(ADDRESS);
  expect(read.filter((t) => t.toLowerCase().includes(ADDRESS))).toEqual([]);
  expect((await body("GET", "/whoami", handled.key)).toLowerCase()).toContain(
    ADDRESS,
  );
});

const TOKEN = "gho_secret-token";
const answering =
  (answer: () => Promise<Response>): typeof fetch =>
  () =>
    answer();

test("a status other than ok or GitHub's 404 refusal is a failure naming the status, not the token", async () => {
  const read = verifiedPrimaryEmail(
    TOKEN,
    answering(async () => new Response(null, { status: 429 })),
  );
  await expect(read).rejects.toThrow(/answered 429/);
  await expect(read).rejects.not.toThrow(TOKEN);
});

test("an unreachable GitHub is a failure naming why, not the token", async () => {
  const read = verifiedPrimaryEmail(
    TOKEN,
    answering(() => Promise.reject(new TypeError("fetch failed"))),
  );
  await expect(read).rejects.toThrow(/unreachable: fetch failed/);
  await expect(read).rejects.not.toThrow(TOKEN);
});

test("a timeout before the answer or during its body is a failure saying it timed out", async () => {
  const timedOut = () =>
    new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
  await expect(
    verifiedPrimaryEmail(
      TOKEN,
      answering(() => Promise.reject(timedOut())),
    ),
  ).rejects.toThrow(/timed out after 3000ms/);
  const slowBody = new Response("[]");
  vi.spyOn(slowBody, "json").mockRejectedValue(timedOut());
  await expect(
    verifiedPrimaryEmail(
      TOKEN,
      answering(async () => slowBody),
    ),
  ).rejects.toThrow(/timed out after 3000ms/);
});

test("an answer that isn't a JSON list is a failure saying so", async () => {
  await expect(
    verifiedPrimaryEmail(
      TOKEN,
      answering(async () => new Response("<html>unicorn</html>")),
    ),
  ).rejects.toThrow(/body that isn't JSON/);
  await expect(
    verifiedPrimaryEmail(
      TOKEN,
      answering(async () => Response.json({ message: "Bad credentials" })),
    ),
  ).rejects.toThrow(/something other than a list/);
});

test("GitHub's 404 and a list with no verified primary are no address, not a failure", async () => {
  await expect(
    verifiedPrimaryEmail(
      TOKEN,
      answering(async () => Response.json({}, { status: 404 })),
    ),
  ).resolves.toBeNull();
  await expect(
    verifiedPrimaryEmail(
      TOKEN,
      answering(async () => Response.json([])),
    ),
  ).resolves.toBeNull();
});

test("a failed read after sign-in logs one warning naming the cause and the actor, never the token, and sign-in goes on", async () => {
  invitePerson("limited-lee");
  failing = async () => new Response(null, { status: 403 });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await signInNow("limited-lee", {
    githubId: 7017,
    emails: verified("lee@example.com"),
  });
  await expect.poll(() => warn.mock.calls.length).toBe(1);
  const [message] = warn.mock.calls[0] ?? [];
  const id = db.select().from(actor).where(eq(actor.githubId, 7017)).get()?.id;
  expect(String(message)).toBe(
    `GitHub email of actor ${id} not stored: GitHub /user/emails answered 403`,
  );
  const token = sentAuth[0]?.replace(/^Bearer /, "");
  expect(token).toBeTruthy();
  expect(String(message)).not.toContain(token);
  expect(stored(7017)?.githubEmail).toBeNull();
});

test("a person GitHub refuses the emails of signs in with no warning", async () => {
  invitePerson("quiet-quinn");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await signIn("quiet-quinn", { githubId: 7018, emails: null });
  expect(stored(7018)?.githubEmail).toBeNull();
  expect(warn).not.toHaveBeenCalled();
});
