import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { beforeAll, expect, test } from "vitest";
import { createBot, setBotHandler } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";
import { mcpClients } from "./test-client.js";

const { app, db, bot, inviteEmail, signInWithEmail } = setupTestApp();
const { connect, call, callError } = mcpClients(app);

const ADA = "ada.mcp@example.com";
let admin: Client;
let handled: Client;
let unhandled: Client;

beforeAll(async () => {
  inviteEmail(ADA);
  await signInWithEmail(ADA);
  const withHandler = createBot(db, "mcp handled");
  setBotHandler(db, withHandler.actor.id, ADA);
  admin = await connect(bot.key);
  handled = await connect(withHandler.key);
  unhandled = await connect(createBot(db, "mcp unhandled").key);
  await call(admin, "create_product", { key: "MHD", name: "mcp handled" });
});

test("file_issue with filed_for handler files for the bot's handler, and get_item shows them by name", async () => {
  const filed = await call(handled, "file_issue", {
    product: "MHD",
    title: "for ada",
    filed_for: "handler",
  });
  expect(filed.filedFor).toEqual({ name: "ada.mcp" });
  const read = await call(admin, "get_item", { item: filed.key });
  expect(read.filedFor).toEqual({ name: "ada.mcp" });
  const own = await call(handled, "file_issue", {
    product: "MHD",
    title: "my own",
  });
  expect(own.filedFor).toBeNull();
});

test("file_issue with filed_for handler and no handler is refused, naming the command that sets one", async () => {
  expect(
    await callError(unhandled, "file_issue", {
      product: "MHD",
      title: "for nobody",
      filed_for: "handler",
    }),
  ).toContain(
    'you have no handler: leave filed_for out to file it as your own, or ask the operator to set one with `trail bot handler "mcp unhandled" <email>`',
  );
});

test("whoami shows the bot's own handler with email; list_bots shows handlers by name alone", async () => {
  expect((await call(handled, "whoami")).handler).toEqual({
    name: "ada.mcp",
    email: ADA,
  });
  expect((await call(unhandled, "whoami")).handler).toBeNull();
  const { items } = await call(admin, "list_bots", { limit: 100 });
  const handlers = items.map((b: { name: string; handler: unknown }) => [
    b.name,
    b.handler,
  ]);
  expect(handlers).toContainEqual(["mcp handled", { name: "ada.mcp" }]);
  expect(handlers).toContainEqual(["mcp unhandled", null]);
});
