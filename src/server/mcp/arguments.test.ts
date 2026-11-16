import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { expect, test } from "vitest";
import { product } from "../db/schema.js";
import { setupTestApp } from "../test-app.js";
import { type Body, mcpClients } from "./test-client.js";

const { app, db, bot, addBot } = setupTestApp();
const { connect, call, callError } = mcpClients(app);

const refused = (tool: string) =>
  `MCP error -32602: Input validation error: Invalid arguments for tool ${tool}: `;

test("a misnamed argument is refused naming the field it meant, the fields the tool takes and a minimal call", async () => {
  const client = await connect(bot.key);
  expect(await callError(client, "get_project", { projectID: "launch" })).toBe(
    `${refused("get_project")}Unrecognized key "projectID" (did you mean project?). get_project takes project. A minimal call: get_project {"project":"..."}`,
  );
});

test("every tool refuses an unknown argument with a minimal call that passes its own argument check", async () => {
  const client = await connect(bot.key);
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(40);
  for (const { name } of tools) {
    const help = await callError(client, name, { zzzz: 1 });
    expect(help, name).toMatch(
      new RegExp(
        `^${refused(name)}(.+\\n)*Unrecognized key "zzzz"\\. ${name} takes `,
      ),
    );
    const example = help?.split(`A minimal call: ${name} `)[1]?.split("\n")[0];
    expect(example, name).toBeDefined();
    const result = await client.callTool({
      name,
      arguments: JSON.parse(example ?? ""),
    });
    const [first] = result.content as { text: string }[];
    expect(first?.text, name).not.toContain("Input validation error");
    // a field only the service requires is still a field the example left out
    expect(first?.text, name).not.toMatch(
      /^validation_failed: \w+ is required/,
    );
  }
});

/** The minimal call `tool`'s help shows for an unknown argument, as arguments. */
async function minimalCall(client: Client, tool: string) {
  const help = await callError(client, tool, { zzzz: 1 });
  return JSON.parse(
    help?.split(`A minimal call: ${tool} `)[1]?.split("\n")[0] ?? "",
  ) as Body;
}

test("message_bot's minimal call sends a message", async () => {
  const client = await connect(bot.key);
  addBot("beta");
  const sent = await call(
    client,
    "message_bot",
    await minimalCall(client, "message_bot"),
  );
  expect(sent.message.to.name).toBe("beta");
});

test("create_webhook's minimal call creates a webhook", async () => {
  const client = await connect(bot.key);
  db.insert(product)
    .values({ key: "ATL", name: "Atlas", createdBy: bot.actor.id })
    .run();
  const created = await call(
    client,
    "create_webhook",
    await minimalCall(client, "create_webhook"),
  );
  expect(created).toMatchObject({ kind: "activity", products: ["ATL"] });
});

test("an unrelated key that starts with a short field's name gets no guess, while a typo still does", async () => {
  const client = await connect(bot.key);
  for (const key of ["topic", "token", "toBot"]) {
    expect(
      await callError(client, "message_bot", {
        to: "beta",
        text: "hi",
        [key]: 1,
      }),
    ).toContain(`Unrecognized key "${key}". message_bot takes`);
  }
  expect(
    await callError(client, "message_bot", { to: "beta", text: "hi", txt: 1 }),
  ).toContain(`Unrecognized key "txt" (did you mean text?)`);
});
