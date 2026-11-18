// Soak check: runs the built server (`pnpm build` first) under load and prints heap used at intervals.
// Not part of CI. Usage: node scripts/soak.mjs [--minutes 10] [--interval 30] [--snapshots <dir>]
// The load: bots on REST and MCP (MCP calls often dropped mid-flight), items linking pull requests
// of a fake GitHub, webhooks to a local receiver that is sometimes slow or down, and people's live
// event streams that open and drop. Everything stays on 127.0.0.1; GitHub is never called.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    minutes: { type: "string", default: "10" },
    interval: { type: "string", default: "30" },
    snapshots: { type: "string" },
    bots: { type: "string", default: "15" },
    // rest, mcp or live alone, to tell which load grows the heap
    only: { type: "string" },
  },
});
const minutes = Number(values.minutes);
const intervalS = Number(values.interval);
const botCount = Number(values.bots);
const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "trail-soak-"));
if (values.snapshots) mkdirSync(values.snapshots, { recursive: true });

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
const githubPort = await listen(github);
const receiverPort = await listen(receiver);

const env = {
  ...process.env,
  NODE_ENV: "production",
  DATABASE_PATH: join(dir, "trail.db"),
  PORT: "0",
  TRAIL_OWNER_GITHUB: "soak-owner",
  BETTER_AUTH_SECRET: "soak-secret-that-is-at-least-32-characters",
  SOAK_GITHUB_PORT: String(githubPort),
  SOAK_RECEIVER_PORT: String(receiverPort),
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

const server = spawn(
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
const ask = (message) =>
  new Promise((resolve) => {
    heapWaiters.push(resolve);
    server.send(message);
  });

for (let i = 0; i < 100; i++) {
  if (
    await fetch(`${base}/health`).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  await new Promise((r) => setTimeout(r, 200));
}

async function cli(...args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(root, "dist/cli.js"), ...args], {
      env,
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(out)),
    );
  });
}

const bots = [];
for (let i = 0; i < botCount; i++) {
  const key = (
    await cli("bot", "create", `soak-bot-${i}`, "--key-only")
  ).trim();
  bots.push({ key, i });
}
const api = (bot, method, path, body, signal) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bot.key}`,
      "content-type": "application/json",
    },
    body: body && JSON.stringify(body),
    signal,
  });
const PRODUCT = "SOK";
await api(bots[0], "POST", "/products", { key: PRODUCT, name: "Soak" });
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
    await api(bot, "POST", `/items/${made.key}/comments`, {
      body: "soak comment",
    });
    await api(bot, "PATCH", `/items/${made.key}`, { status: "in_progress" });
  }
  await api(bot, "GET", "/items?limit=20");
}

async function mcpRound(bot) {
  const drop = Math.random() < 0.5;
  const ctl = new AbortController();
  const init = fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(bot),
    body: mcpBody(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "soak", version: "1" },
      },
      1,
    ),
    signal: ctl.signal,
  });
  // a dropped call is abandoned with no close, as a bot that crashed leaves it
  if (drop) setTimeout(() => ctl.abort(), Math.random() * 5);
  await init.then(
    (r) => r.text(),
    () => null,
  );
  const call = fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(bot),
    body: mcpBody("tools/call", { name: "whoami", arguments: {} }, 2),
    signal: ctl.signal,
  });
  await call.then(
    (r) => r.text(),
    () => null,
  );
}

async function liveRound(cookie) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/web/events`, {
    headers: { cookie },
    signal: ctl.signal,
  }).catch(() => null);
  if (res?.status !== 200 || !res.body) return;
  const reader = res.body.getReader();
  await reader.read().catch(() => null);
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 800));
  ctl.abort();
}

const cookie = process.env.SOAK_WEB_COOKIE;
const stop = Date.now() + minutes * 60_000;
const workers = bots.map(async (bot) => {
  while (Date.now() < stop) {
    const on = (what) => !values.only || values.only === what;
    if (on("rest")) await restRound(bot);
    if (on("mcp")) await mcpRound(bot);
    if (on("live") && cookie && bot.i % 3 === 0) await liveRound(cookie);
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
  }
});

const started = Date.now();
const report = async (label) => {
  const m = await ask({ type: "heap" });
  console.log(
    `${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s  heap used ${(m.heapUsed / 1048576).toFixed(1).padStart(6)} MB  rss ${(m.rss / 1048576).toFixed(0).padStart(4)} MB${label ?? ""}`,
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
server.kill();
github.close();
receiver.close();
process.exit(0);
