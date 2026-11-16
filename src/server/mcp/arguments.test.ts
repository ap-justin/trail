import { expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";
import { mcpClients } from "./test-client.js";

const { app, bot } = setupTestApp();
const { connect, callError } = mcpClients(app);

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
  }
});
