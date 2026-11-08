import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate, openDatabase } from "./db/client.js";

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
migrate(db);
const server = serve(
  { fetch: createApp().fetch, port: config.PORT },
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
