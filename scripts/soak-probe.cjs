// Preloaded into the server by scripts/soak.mjs with `node --require`; never part of the build.
// It answers the soak's IPC messages with heap numbers or a heap snapshot, and sends the server's
// outbound calls, GitHub's pull request API, webhook receivers and Resend's mail API, to local stand-ins.
const v8 = require("node:v8");
const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");
const { syncBuiltinESMExports } = require("node:module");

const githubPort = Number(process.env.SOAK_GITHUB_PORT);
const receiverPort = Number(process.env.SOAK_RECEIVER_PORT);
const resendPort = Number(process.env.SOAK_RESEND_PORT);

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  if (url.startsWith("https://api.github.com/")) {
    return realFetch(
      `http://127.0.0.1:${githubPort}${url.slice("https://api.github.com".length)}`,
      init,
    );
  }
  if (url.startsWith("https://api.resend.com/")) {
    return realFetch(
      `http://127.0.0.1:${resendPort}${url.slice("https://api.resend.com".length)}`,
      init,
    );
  }
  return realFetch(input, init);
};

// a public-looking address for every webhook host, so the address check passes
dnsPromises.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
dns.lookup = (_host, opts, cb) =>
  (typeof opts === "function" ? opts : cb)(null, "93.184.216.34", 4);
https.request = (options, callback) =>
  http.request({ ...options, host: "127.0.0.1", port: receiverPort }, callback);
syncBuiltinESMExports();

process.on("message", (message) => {
  if (message.type === "heap") {
    global.gc?.();
    global.gc?.();
    const { heapUsed, heapTotal, rss, external, arrayBuffers } =
      process.memoryUsage();
    process.send({
      type: "heap",
      heapUsed,
      heapTotal,
      rss,
      external,
      arrayBuffers,
    });
  } else if (message.type === "snapshot") {
    global.gc?.();
    const file = v8.writeHeapSnapshot(message.file);
    process.send({ type: "snapshot", file });
  }
});
