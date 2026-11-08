import { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate, openDatabase } from "./db/client.js";
import { createEventBus } from "./events/bus.js";
import { onShutdownSignal } from "./shutdown.js";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
migrate(db);
const server = serve(
  { fetch: createApp({ db, bus: createEventBus() }).fetch, port: config.PORT },
  (info) => {
    console.log(`trail listening on :${info.port}`);
  },
);
// serve() types an http2 server too, which only a createServer option yields
if (!(server instanceof Server)) throw new Error("expected an HTTP/1 server");

onShutdownSignal({
  server,
  onClosed: () => db.$client.close(),
  // under Fly's default kill_timeout (5 s), or the drain is killed mid-way
  deadlineMs: 4_000,
});
