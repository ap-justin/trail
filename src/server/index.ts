import { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { loadConfig } from "./config.js";
import { migrate, openDatabase } from "./db/client.js";
import { createEventBus } from "./events/bus.js";
import { webhookSettings } from "./service/webhooks.js";
import { onShutdownSignal } from "./shutdown.js";
import { LiveStreams } from "./web/events.js";
import { deriveSecretKey } from "./webhooks/secret.js";
import { createWebhookWorker } from "./webhooks/worker.js";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
migrate(db);
if ("missing" in config.github) {
  console.warn(
    `GitHub sign-in is off until ${config.github.missing.join(" and ")} is set; bots are unaffected`,
  );
}
if ("missing" in config.email) {
  console.warn(
    `Email sign-in is off until ${config.email.missing.join(" and ")} is set; GitHub sign-in is unaffected`,
  );
}
const auth = createAuth({ db, config });
// vite builds the SPA to dist/web, beside this module once bundled to dist/index.js;
// under tsx this is src/server/index.ts, and `./web` there is the API's source
const webDir = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "../../dist/web" : "./web",
    import.meta.url,
  ),
);
const streams = new LiveStreams();
const bus = createEventBus();
// aborts at the start of a drain, so a test call to a slow receiver doesn't hold the shutdown
const draining = new AbortController();
const webhooks = webhookSettings(deriveSecretKey(config.BETTER_AUTH_SECRET), {
  publicUrl: config.BETTER_AUTH_URL,
  signal: draining.signal,
});
const webhookWorker = createWebhookWorker({ db, bus, settings: webhooks });
const server = serve(
  {
    fetch: createApp({ db, bus, auth, streams, webDir, webhooks }).fetch,
    port: config.PORT,
  },
  (info) => {
    console.log(`trail listening on :${info.port}`);
    // after the first listen: a restart sends what the outbox still holds
    webhookWorker.start();
  },
);
// serve() types an http2 server too, which only a createServer option yields
if (!(server instanceof Server)) throw new Error("expected an HTTP/1 server");

onShutdownSignal({
  server,
  onDraining: () => {
    draining.abort();
    void streams.end();
  },
  // a stream the deadline cut can still be mid-query: the database closes after its last
  onClosed: async () => {
    await streams.end();
    await webhookWorker.stop();
    db.$client.close();
  },
  // plus shutdown-sync-timeout, under shutdown-timeout in litestream.yml, or the drain is killed mid-way
  deadlineMs: 4_000,
});
