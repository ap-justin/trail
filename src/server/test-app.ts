import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createApp } from "./app.js";
import { migrate, openDatabase } from "./db/client.js";
import { type ActivityEvent, createEventBus } from "./events/bus.js";
import { createBot } from "./service/keys.js";

/**
 * The app over a fresh migrated SQLite file, removed after the test file, with
 * one bot and a `request` that sends its key. Call once at a test file's top level.
 */
export function setupTestApp() {
  const dir = mkdtempSync(join(tmpdir(), "trail-api-"));
  const db = openDatabase(join(dir, "trail.db"));
  migrate(db);
  afterAll(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const bus = createEventBus();
  const published: ActivityEvent[] = [];
  bus.subscribe((event) => published.push(event));
  const app = createApp({ db, bus });
  const bot = createBot(db, "tester");

  /** Sends `json` as the body and the bot's key unless `key` overrides it (null sends none). */
  function request(
    method: string,
    path: string,
    { json, key = bot.key }: { json?: unknown; key?: string | null } = {},
  ) {
    const headers: Record<string, string> = {};
    if (key !== null) headers.authorization = `Bearer ${key}`;
    if (json !== undefined) headers["content-type"] = "application/json";
    return app.request(path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  }

  return { db, bus, app, bot, published, request };
}
