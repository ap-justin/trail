import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { actor, invite, productMember } from "../db/schema.js";
import { createBot, setBotHandler } from "../service/keys.js";
import { setupTestApp, TEST_OWNER } from "../test-app.js";

/** Holds GitHub's /user/emails answer until it resolves; each test that sets it clears it. */
let held: Promise<void> | null = null;
// email reads not yet stored; a read's store is done by the event-loop turn after its answer
let reading = 0;
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

test("an unverified primary address is never stored, nor is a verified one that isn't primary", async () => {
  invitePerson("unverified-pat");
  await signIn("unverified-pat", {
    githubId: 7002,
    emails: [
      { email: "pat@example.com", primary: true, verified: false },
      { email: "pat-second@example.com", primary: false, verified: true },
    ],
  });
  expect(stored(7002)?.githubEmail).toBeNull();
});

test("nothing is stored when GitHub lists none, refuses the token, or gives its private-address stand-in", async () => {
  invitePerson("empty-eli");
  invitePerson("scopeless-sam");
  invitePerson("private-pip");
  await signIn("empty-eli", { githubId: 7003, emails: [] });
  await signIn("scopeless-sam", { githubId: 7004, emails: null });
  await signIn("private-pip", {
    githubId: 7005,
    emails: verified("7005+private-pip@users.noreply.github.com"),
  });
  for (const id of [7003, 7004, 7005]) {
    expect(stored(id), `${id}`).toEqual({ githubEmail: null, email: null });
  }
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
  const cookie = await signIn("second-gus", {
    githubId: 7009,
    emails: verified("Shared@Example.com"),
  });
  const refusals = warn.mock.calls.filter(([m]) =>
    String(m).includes("not stored"),
  );
  warn.mockRestore();
  expect(refusals).toHaveLength(1);
  expect(stored(7008)?.githubEmail).toBe("shared@example.com");
  expect(stored(7009)?.githubEmail).toBeNull();
  expect(cookie).toBeTruthy();
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
  warn.mockRestore();
  expect(stored(7010)?.githubEmail).toBeNull();
});

test("an invited address a GitHub person holds lets no second person in under it", async () => {
  invitePerson("holder-hal");
  await signIn("holder-hal", {
    githubId: 7011,
    emails: verified("taken@example.com"),
  });
  inviteEmail("taken@example.com");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await signInWithEmail("taken@example.com");
  warn.mockRestore();
  expect(
    db.select().from(actor).where(eq(actor.email, "taken@example.com")).all(),
  ).toEqual([]);
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
  const refusal =
    /a handler must have an email on file \(invited by email, or signed in with GitHub with a verified primary email\)/;
  expect(() =>
    setBotHandler(db, handled.actor.id, "nobody@example.com"),
  ).toThrow(refusal);
  expect(() =>
    setBotHandler(db, handled.actor.id, "silent-jo@example.com"),
  ).toThrow(refusal);
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

test("a person whose invite was removed is no longer found by their address", async () => {
  invitePerson("gone-kit");
  await signIn("gone-kit", {
    githubId: 7014,
    emails: verified("kit@example.com"),
  });
  db.delete(invite).where(eq(invite.username, "gone-kit")).run();
  const handled = createBot(db, "kit handled");
  expect(() => setBotHandler(db, handled.actor.id, "kit@example.com")).toThrow(
    /no trail member/,
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
