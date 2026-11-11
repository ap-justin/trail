import { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { loadConfig } from "./config.js";
import { migrate, openDatabase } from "./db/client.js";
import { createEventBus } from "./events/bus.js";
import { onShutdownSignal } from "./shutdown.js";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
migrate(db);
if ("missing" in config.github) {
  console.warn(
    `GitHub sign-in is off until ${config.github.missing.join(" and ")} is set; bots are unaffected`,
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
const draining = new AbortController();
const server = serve(
  {
    fetch: createApp({
      db,
      bus: createEventBus(),
      auth,
      shutdown: draining.signal,
      webDir,
    }).fetch,
    port: config.PORT,
  },
  (info) => {
    console.log(`trail listening on :${info.port}`);
  },
);
// serve() types an http2 server too, which only a createServer option yields
if (!(server instanceof Server)) throw new Error("expected an HTTP/1 server");

onShutdownSignal({
  server,
  onDraining: () => draining.abort(),
  onClosed: () => db.$client.close(),
  // plus shutdown-sync-timeout, under shutdown-timeout in litestream.yml, or the drain is killed mid-way
  deadlineMs: 4_000,
});
