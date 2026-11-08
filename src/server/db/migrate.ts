// `pnpm db:migrate`: applies pending migrations to DATABASE_PATH. The server
// imports migrate() from client.ts, never this file, so bundling it runs nothing.
import { loadConfig } from "../config.js";
import { migrate, openDatabase } from "./client.js";

const { DATABASE_PATH } = loadConfig();
const db = openDatabase(DATABASE_PATH);
try {
  migrate(db);
  console.log(`migrated ${DATABASE_PATH}`);
} finally {
  db.$client.close();
}
