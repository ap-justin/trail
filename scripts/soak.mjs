// Soak check: runs the built server (`pnpm build` first) under load and prints memory at intervals,
// each sample taken right after a forced GC: rss, heap used, heap total, external and array buffers.
// Not part of CI. Usage: node scripts/soak.mjs [--minutes 10] [--interval 60] [--bots 15] [--pause 500] [--only <load>] [--snapshots <dir>]
// <load> is one of rest, mcp, live, notes, teams, mail, web, messages; leave --only out for all of them.
// The people's loads (live, web) sign a person in by email through the fake Resend below, and are skipped
// when that fails. A bad flag exits 2; a server that dies mid-run still gets the tally, and exits 1.
// The load: bots on REST and MCP (MCP calls often dropped mid-flight, with a mix of tools), items linking
// pull requests of a fake GitHub, webhooks to a local receiver that is sometimes slow or down, notes
// (with about, edits, reads and lists), teams, issues filed for a handler and then ended so the end-of-issue
// mail goes out through a fake Resend that sometimes refuses, bot messages, and a person's live event
// streams and project, product and item pages. Everything stays on 127.0.0.1; GitHub and Resend are never called.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";

const { values } = parseArgs({
  options: {
    minutes: { type: "string", default: "10" },
    interval: { type: "string", default: "60" },
    snapshots: { type: "string" },
    bots: { type: "string", default: "15" },
    // the average wait between a bot's rounds, in ms: raise it for a load as light as production's
    pause: { type: "string", default: "500" },
    // one load alone, to tell which grows the heap
    only: { type: "string" },
  },
});
const usage = (message) => {
  console.error(`soak: ${message}`);
  process.exit(2);
};
const numberFlag = (name, ok, wanted) => {
  const n = Number(values[name]);
  if (!ok(n)) usage(`--${name} must be ${wanted}, got ${values[name]}`);
  return n;
};
const minutes = numberFlag("minutes", (n) => n > 0, "a number above 0");
// setInterval reads a delay under 1 ms as 1 ms
const intervalS = numberFlag(
  "interval",
  (n) => n >= 0.001,
  "seconds, 0.001 or more",
);
const botCount = numberFlag(
  "bots",
  (n) => Number.isInteger(n) && n >= 1,
  "a whole number, 1 or more",
);
const pauseMs = numberFlag("pause", (n) => n >= 0, "milliseconds, 0 or more");
const LOADS = [
  "rest",
  "mcp",
  "live",
  "notes",
  "teams",
  "mail",
  "web",
  "messages",
];
if (values.only !== undefined && !LOADS.includes(values.only))
  usage(`--only must be one of ${LOADS.join(", ")}, got ${values.only}`);
// a request or CLI call that takes longer is counted as failed, so a stalled answer can't outlast --minutes
const REQUEST_TIMEOUT_MS = 30_000;
const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "trail-soak-"));
if (values.snapshots) mkdirSync(values.snapshots, { recursive: true });
let server;
// sync, so it also runs from 'exit' after a crash: the server is killed rather than drained
const cleanUp = () => {
  if (server && server.exitCode === null && server.signalCode === null)
    server.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
};
process.on("exit", cleanUp);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    cleanUp();
    process.kill(process.pid, signal);
  });

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );

// a fake GitHub: every pull request is open, a few answer slowly or with an error
const github = createServer((req, res) => {
  const n = Number(req.url.split("/").pop());
  if (n % 7 === 0) {
    res.writeHead(500).end();
  } else if (n % 5 === 0) {
    setTimeout(
      () => res.writeHead(200).end(JSON.stringify({ state: "open" })),
      1500,
    );
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ state: "open", draft: false, merged: false }));
  }
});
// a receiver that is sometimes slow and sometimes down
let receiverCalls = 0;
const receiver = createServer((req, res) => {
  req.resume();
  const n = receiverCalls++;
  if (n % 6 === 0) return res.destroy();
  if (n % 4 === 0)
    return void setTimeout(() => res.writeHead(200).end(), 12_000);
  res.writeHead(n % 5 === 0 ? 500 : 200).end();
});
// a fake Resend: it keeps the last sign-in link per address, and refuses some issue-ended emails
const signInLinks = new Map();
// each mail's latest answer, by its idempotency key, so a retried mail counts once
const mailOutcome = new Map();
let mailCalls = 0;
const resend = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const mail = JSON.parse(body);
    if (mail.subject?.toLowerCase().includes("sign")) {
      signInLinks.set(mail.to[0], mail.text.match(/https?:\/\/\S+/)?.[0]);
      return res.writeHead(200).end("{}");
    }
    const n = mailCalls++;
    const id = req.headers["idempotency-key"] ?? `call ${n}`;
    // a refusal that is retried (5xx, 429), one that is final (422), and a stalled answer
    const status = [200, 200, 500, 200, 429, 200, 422][n % 7];
    if (n % 11 === 10) {
      mailOutcome.set(id, "stalled");
      return void setTimeout(() => res.destroy(), 11_000);
    }
    mailOutcome.set(id, status === 200 ? "accepted" : "refused");
    res.writeHead(status).end("{}");
  });
});
const githubPort = await listen(github);
const receiverPort = await listen(receiver);
const resendPort = await listen(resend);

const env = {
  ...process.env,
  NODE_ENV: "production",
  DATABASE_PATH: join(dir, "trail.db"),
  PORT: "0",
  TRAIL_OWNER_GITHUB: "soak-owner",
  BETTER_AUTH_SECRET: "soak-secret-that-is-at-least-32-characters",
  SOAK_GITHUB_PORT: String(githubPort),
  SOAK_RECEIVER_PORT: String(receiverPort),
  SOAK_RESEND_PORT: String(resendPort),
  EMAIL_FROM: "trail <trail@mail.example.test>",
  RESEND_API_KEY: "re_soak_key",
  // blanked, not inherited from the shell: "" reads as unset (src/server/config.ts)
  GITHUB_CLIENT_ID: "",
  GITHUB_CLIENT_SECRET: "",
  GITHUB_TOKEN: "",
};
const serverPort = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
env.PORT = String(serverPort);
const base = `http://127.0.0.1:${serverPort}`;
env.BETTER_AUTH_URL = base;

server = spawn(
  process.execPath,
  [
    "--expose-gc",
    "--require",
    join(root, "scripts/soak-probe.cjs"),
    join(root, "dist/index.js"),
  ],
  { env, cwd: root, stdio: ["ignore", "ignore", "inherit", "ipc"] },
);
const heapWaiters = [];
server.on("message", (m) => heapWaiters.shift()?.(m));
// a heap snapshot of a large heap takes seconds; a server that answers none in this time is stuck
const ASK_TIMEOUT_MS = 60_000;
// answers null once the server is gone, so a sample never waits on a dead process
const ask = (message) =>
  new Promise((resolve) => {
    if (!server.connected) return resolve(null);
    const timer = setTimeout(() => {
      // the slot stays, so a late answer is dropped rather than handed to the next asker
      const i = heapWaiters.indexOf(answer);
      if (i !== -1) heapWaiters[i] = () => {};
      resolve(null);
    }, ASK_TIMEOUT_MS);
    const answer = (m) => {
      clearTimeout(timer);
      resolve(m);
    };
    heapWaiters.push(answer);
    server.send(message, (error) => {
      if (!error) return;
      const i = heapWaiters.indexOf(answer);
      if (i !== -1) heapWaiters.splice(i, 1);
      answer(null);
    });
  });
let stop = Number.POSITIVE_INFINITY;
let stopping = false;
let serverDied = false;
const exited = new Promise((resolve) => server.once("exit", resolve));
server.once("exit", (code, signal) => {
  for (const waiter of heapWaiters.splice(0)) waiter(null);
  if (stopping) return;
  serverDied = true;
  stop = 0;
  console.error(
    `soak: the server exited (code ${code}, signal ${signal}); stopping the load`,
  );
});

let healthy = false;
for (let i = 0; i < 100 && !healthy && !serverDied; i++) {
  healthy = await fetch(`${base}/health`, {
    signal: AbortSignal.timeout(1000),
  })
    .then(async (r) => {
      await r.text();
      return r.ok;
    })
    .catch(() => false);
  if (!healthy) await new Promise((r) => setTimeout(r, 200));
}
if (!healthy)
  throw new Error(
    `the server never answered ${base}/health (pnpm build first?)`,
  );

async function cli(...args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(root, "dist/cli.js"), ...args], {
      env,
      timeout: REQUEST_TIMEOUT_MS,
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code, signal) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(
              err ||
                out ||
                `trail ${args.join(" ")} ended by ${signal ?? code}`,
            ),
          ),
    );
  });
}

const bots = [];
for (let i = 0; i < botCount; i++) {
  const key = (
    await cli("bot", "create", `soak-bot-${i}`, "--key-only")
  ).trim();
  bots.push({ key, i, name: `soak-bot-${i}`, keys: [] });
}
// bots that own no product, so each may create one team
const TEAM_BOTS = 4;
const teamBots = [];
for (let i = 0; i < TEAM_BOTS; i++) {
  const key = (
    await cli("bot", "create", `soak-team-bot-${i}`, "--key-only")
  ).trim();
  teamBots.push({ key, i, name: `soak-team-bot-${i}` });
}
// how each call answered, by route with keys and numbers blanked: a load that only gets 4xx shows here
const answers = new Map();
const samples = new Map();
const tally = (method, path, status) => {
  const k = `${method} ${path.replace(/[A-Z]{2,5}-\d+|(?<=product=)[A-Z]{2,5}|\d+/g, "#")} ${status}`;
  answers.set(k, (answers.get(k) ?? 0) + 1);
};
// a fetch that never answered: TimeoutError, AbortError, or the network error's code
const failure = (error) => error.cause?.code ?? error.name;
// every body is read: an unread one keeps its connection open, and the server's rss and buffers with it
const api = async (bot, method, path, body, signal) => {
  let status;
  let text;
  try {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bot.key}`,
        "content-type": "application/json",
      },
      body: body && JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (error) {
    tally(method, path, failure(error));
    throw error;
  }
  tally(method, path, status);
  if (status >= 400 && !samples.has(`${method} ${status}`))
    samples.set(`${method} ${status}`, text);
  return { status, json: async () => JSON.parse(text) };
};
const PRODUCT = "SOK";
const product = await api(bots[0], "POST", "/products", {
  key: PRODUCT,
  name: "Soak",
}).then((r) => r.json());
const SLUG = "soak-project";
await api(bots[0], "POST", "/projects", { name: "Soak project", slug: SLUG });
// a person, invited by email to the product, who is the handler of every other bot (an even-numbered one)
const PERSON = "soak-person@example.test";
const handlerId = (await api(bots[0], "GET", "/whoami").then((r) => r.json()))
  .id;
{
  const sqlite = new Database(join(dir, "trail.db"));
  sqlite.pragma("busy_timeout = 5000");
  const { lastInsertRowid } = sqlite
    .prepare(
      "INSERT INTO invite (email, invited_by, created_at) VALUES (?, ?, ?)",
    )
    .run(PERSON, handlerId, Date.now());
  sqlite
    .prepare(
      "INSERT INTO product_member (invite_id, product_id, created_at) VALUES (?, ?, ?)",
    )
    .run(lastInsertRowid, product.id, Date.now());
  sqlite.close();
}

for (const bot of bots) {
  await api(bot, "POST", "/webhooks", {
    url: `https://hooks.example.test/${bot.i}`,
    secret: "soak-webhook-secret-0123456789",
    products: [PRODUCT],
  });
}

let pullNumber = 0;
const mcpBody = (method, params, id) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const mcpHeaders = (bot) => ({
  authorization: `Bearer ${bot.key}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
});

async function restRound(bot) {
  const made = await api(bot, "POST", "/items", {
    type: "issue",
    product: PRODUCT,
    title: `soak item ${bot.i}`,
    links: [
      {
        url: `https://github.com/acme/widgets/pull/${++pullNumber}`,
        title: "PR",
      },
    ],
  }).then(
    (r) => r.json(),
    () => null,
  );
  if (made?.key) {
    bot.lastKey = made.key;
    await api(bot, "POST", `/items/${made.key}/comments`, {
      body: "soak comment",
    });
    await api(bot, "PATCH", `/items/${made.key}`, { status: "in_progress" });
  }
  await api(bot, "GET", "/items?limit=20");
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const peer = (bot) => bots[(bot.i + 1) % bots.length].name;
const mcpTools = (bot) => [
  { name: "whoami", arguments: {} },
  {
    name: "add_note",
    arguments: {
      product: PRODUCT,
      title: `soak note ${bot.i}`,
      description: "how the soak works",
      ...(bot.lastKey && { about: [bot.lastKey] }),
    },
  },
  ...(bot.lastKey
    ? [
        { name: "get_item", arguments: { item: bot.lastKey } },
        { name: "list_items", arguments: { about: bot.lastKey } },
      ]
    : []),
  { name: "list_items", arguments: { type: "note", product: PRODUCT } },
  { name: "list_items", arguments: { product: PRODUCT, limit: 20 } },
  { name: "create_team", arguments: { name: "Soak team", key: "SQM" } },
  {
    name: "message_bot",
    arguments: { to: peer(bot), text: "soak ping", expectsReply: false },
  },
];

// a tool's refusal is a 200 with isError, a protocol error a 200 with error: both tallied as refused
const mcpCall = async (bot, what, body, signal) => {
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: mcpHeaders(bot),
      body,
      signal,
    });
    const text = await res.text();
    tally(
      "MCP",
      what,
      /"isError":true|"error":\{/.test(text)
        ? `${res.status} refused`
        : res.status,
    );
  } catch (error) {
    tally("MCP", what, failure(error));
  }
};

async function mcpRound(bot) {
  const drop = Math.random() < 0.5;
  const ctl = new AbortController();
  const signal = () =>
    AbortSignal.any([ctl.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const init = mcpCall(
    bot,
    "initialize",
    mcpBody(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "soak", version: "1" },
      },
      1,
    ),
    signal(),
  );
  // a dropped call is abandoned with no close, as a bot that crashed leaves it
  if (drop) setTimeout(() => ctl.abort(), Math.random() * 5);
  await init;
  const tool = pick(mcpTools(bot));
  await mcpCall(
    bot,
    `tools/call ${tool.name}`,
    mcpBody("tools/call", tool, 2),
    signal(),
  );
}

// notes about an item, edited, read back, listed and archived
async function notesRound(bot) {
  const about = bot.lastKey ? [bot.lastKey] : [];
  const note = await api(bot, "POST", "/items", {
    type: "note",
    product: PRODUCT,
    title: `soak note ${bot.i}`,
    description: "x".repeat(200 + Math.floor(Math.random() * 2000)),
    about,
    project: Math.random() < 0.3 ? SLUG : undefined,
  }).then(
    (r) => r.json(),
    () => null,
  );
  if (!note?.key) return;
  await api(bot, "PATCH", `/items/${note.key}`, {
    title: `soak note ${bot.i} edited`,
    ...(bot.lastKey && Math.random() < 0.5
      ? { addAbout: [bot.lastKey] }
      : { removeAbout: about }),
  });
  if (bot.lastKey) {
    await api(bot, "GET", `/items/${bot.lastKey}`);
    await api(bot, "GET", `/items?about=${bot.lastKey}`);
  }
  await api(bot, "GET", `/items?type=note&product=${PRODUCT}&status=current`);
  if (Math.random() < 0.5)
    await api(bot, "PATCH", `/items/${note.key}`, { status: "archived" });
}

// a team a bot creates once and keeps writing in, and the refusals once it has one
async function teamsRound(bot) {
  const key = `SQ${"ABCD"[bot.i]}`;
  await api(bot, "POST", "/teams", { name: `Soak team ${bot.i}`, key });
  await api(bot, "POST", "/items", {
    type: "todo",
    product: key,
    title: "soak team todo",
  });
  await api(bot, "GET", "/whoami");
  await api(bot, "GET", `/items?product=${key}&limit=20`);
}

// an issue filed for the bot's handler, then ended: the end-of-issue mail is queued and sent
async function mailRound(bot) {
  const made = await api(bot, "POST", "/items", {
    type: "issue",
    product: PRODUCT,
    title: `soak filed for ${bot.i}`,
    filed_for: "handler",
  }).then(
    (r) => r.json(),
    () => null,
  );
  if (!made?.key) return;
  await api(bot, "POST", `/items/${made.key}/comments`, {
    body: "wrapping up",
  });
  await api(bot, "PATCH", `/items/${made.key}`, {
    status: Math.random() < 0.7 ? "done" : "canceled",
  });
}

async function messagesRound(bot) {
  await api(bot, "POST", "/messages", {
    to: peer(bot),
    text: "soak message",
    expectsReply: Math.random() < 0.5,
  });
  await api(bot, "GET", "/messages");
}

// what a person's browser reads: the project and product pages, the Notes section, an item
async function webRound(cookie, bot) {
  const get = async (path) => {
    try {
      const res = await fetch(`${base}/api/web${path}`, {
        headers: { cookie },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await res.text();
      tally("WEB GET", path, res.status);
    } catch (error) {
      tally("WEB GET", path, failure(error));
    }
  };
  await get("/me");
  await get("/projects");
  await get(`/projects/${SLUG}`);
  await get(`/projects/${SLUG}/items`);
  await get(`/projects/${SLUG}/items?type=note&status=current`);
  await get(`/products/${PRODUCT}`);
  await get(`/products/${PRODUCT}/items?type=note`);
  await get("/feed");
  await get("/search?q=soak");
  if (bot.lastKey) await get(`/items/${bot.lastKey}`);
}

// the session cookie, or undefined when the sign-in failed
async function signIn() {
  const headers = { origin: base, "content-type": "application/json" };
  const post = async (path, body) => {
    try {
      const res = await fetch(`${base}/api/auth${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await res.text();
      tally("AUTH POST", path, res.status);
      return res;
    } catch (error) {
      tally("AUTH POST", path, failure(error));
      return null;
    }
  };
  await post("/sign-in/magic-link", { email: PERSON, callbackURL: "/" });
  for (let i = 0; i < 50 && !signInLinks.get(PERSON); i++)
    await new Promise((r) => setTimeout(r, 100));
  const link = signInLinks.get(PERSON);
  if (!link) return undefined;
  const query = new URL(link).searchParams;
  const res = await post("/magic-link/confirm", {
    token: query.get("token"),
    callbackURL: query.get("callbackURL") ?? undefined,
  });
  return res?.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.includes("session_token="));
}

async function liveRound(cookie) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/web/events`, {
    headers: { cookie },
    signal: AbortSignal.any([
      ctl.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]),
  }).catch((error) => {
    tally("WEB GET", "/events", failure(error));
    return null;
  });
  if (!res) return;
  tally("WEB GET", "/events", res.status);
  if (res.status !== 200 || !res.body) return void res.body?.cancel();
  const reader = res.body.getReader();
  await reader.read().catch(() => null);
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 800));
  ctl.abort();
}

const cookie = await signIn();
// a handler can be set once the person has signed in
if (cookie) {
  for (const bot of bots) {
    if (bot.i % 2 === 0) await cli("bot", "handler", bot.name, PERSON);
  }
} else {
  console.error(
    "no person signed in: the live and web loads are skipped, and the mail load has no handler",
  );
}
stop = Math.min(stop, Date.now() + minutes * 60_000);
const on = (what) => !values.only || values.only === what;
const pause = () =>
  new Promise((r) => setTimeout(r, pauseMs * (0.6 + Math.random() * 0.8)));
// a round that threw is tallied and the next one runs: one bad answer doesn't end the run unreported
const failedRound = (error) => tally("ROUND", "threw", failure(error));
const workers = bots.map(async (bot) => {
  while (Date.now() < stop) {
    try {
      // rest first: the other loads read what it filed
      if (on("rest") || bot.lastKey === undefined) await restRound(bot);
      if (on("mcp")) await mcpRound(bot);
      if (on("notes")) await notesRound(bot);
      if (on("mail") && bot.i % 2 === 0) await mailRound(bot);
      if (on("messages")) await messagesRound(bot);
      if (on("live") && cookie && bot.i % 3 === 0) await liveRound(cookie);
      if (on("web") && cookie && bot.i % 3 === 1) await webRound(cookie, bot);
    } catch (error) {
      failedRound(error);
    }
    await pause();
  }
});
if (on("teams"))
  for (const bot of teamBots)
    workers.push(
      (async () => {
        while (Date.now() < stop) {
          await teamsRound(bot).catch(failedRound);
          await pause();
        }
      })(),
    );

const started = Date.now();
const mb = (n) => `${(n / 1048576).toFixed(1).padStart(6)} MB`;
const report = async (label) => {
  const m = await ask({ type: "heap" });
  const elapsed = Date.now() - started;
  // whole minutes would print the same time for every sample under a minute apart
  const at =
    intervalS < 60
      ? `${(elapsed / 1000).toFixed(1).padStart(7)} s`
      : `${String(Math.round(elapsed / 60_000)).padStart(4)} min`;
  if (!m)
    return console.log(
      `${at}  no sample: the server is gone or didn't answer${label ?? ""}`,
    );
  console.log(
    `${at}  rss ${mb(m.rss)}  heapUsed ${mb(m.heapUsed)}  heapTotal ${mb(m.heapTotal)}  external ${mb(m.external)}  arrayBuffers ${mb(m.arrayBuffers)}${label ?? ""}`,
  );
};
await report(" (start)");
let snap = 0;
const ticker = setInterval(async () => {
  await report();
  if (values.snapshots && ++snap % 2 === 0) {
    await ask({
      type: "snapshot",
      file: join(values.snapshots, `heap-${snap}.heapsnapshot`),
    });
  }
}, intervalS * 1000);
await Promise.all(workers);
clearInterval(ticker);
await report(" (end)");
if (values.snapshots)
  await ask({
    type: "snapshot",
    file: join(values.snapshots, "heap-final.heapsnapshot"),
  });
console.log(
  `${[...answers]
    .sort()
    .map(([k, n]) => `${String(n).padStart(6)}  ${k}`)
    .join("\n")}`,
);
for (const [k, text] of samples)
  console.log(`first ${k}: ${text.slice(0, 300)}`);
const mailCount = (outcome) =>
  [...mailOutcome.values()].filter((o) => o === outcome).length;
console.log(
  `mail: ${mailOutcome.size} mails in ${mailCalls} calls; by latest answer ${mailCount("accepted")} accepted, ${mailCount("refused")} refused, ${mailCount("stalled")} stalled`,
);
stopping = true;
server.kill();
// the server drains for up to 4 s (src/server/index.ts deadlineMs); the 'exit' cleanup kills what is left
await Promise.race([exited, new Promise((r) => setTimeout(r, 6000))]);
for (const fake of [github, receiver, resend]) {
  fake.closeAllConnections();
  fake.close();
}
process.exit(serverDied ? 1 : 0);
