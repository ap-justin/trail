import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const server = serve(
  { fetch: createApp().fetch, port: config.PORT },
  (info) => {
    console.log(`trail listening on :${info.port}`);
  },
);

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
