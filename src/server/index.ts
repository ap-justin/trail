import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate, openDatabase } from "./db/client.js";
import { createEventBus } from "./events/bus.js";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
migrate(db);
const server = serve(
  { fetch: createApp({ db, bus: createEventBus() }).fetch, port: config.PORT },
  (info) => {
    console.log(`trail listening on :${info.port}`);
  },
);

process.on("SIGTERM", () => {
  server.close(() => {
    db.$client.close();
    process.exit(0);
  });
});
