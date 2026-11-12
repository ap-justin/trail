import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { setupTestApp } from "../test-app.js";
import { JPEG, OTHER_PNG, PNG, pngOfSize, SVG, TEXT } from "../test-images.js";

const { app, db, bot, request, addBot, addProject } = setupTestApp();

// biome-ignore lint/suspicious/noExplicitAny: loose tool results for field reads
type Body = Record<string, any>;

const endpoint = new URL("http://trail.test/mcp");
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

async function connect(key: string) {
  const client = new Client({ name: "trail-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
      fetch: async (url, init) => app.request(String(url), init),
    }),
  );
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Body = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  expect(result.isError, first?.text).toBeFalsy();
  return JSON.parse(first?.text ?? "null") as Body;
}

/** The error text of a call that must fail. */
async function refusal(client: Client, name: string, args: Body = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  expect(result.isError, first?.text).toBe(true);
  return first?.text ?? "";
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

let wide: Client;
beforeAll(async () => {
  wide = await connect(bot.key);
});

test("a bot sets, replaces and clears its photo, and whoami follows", async () => {
  const first = await call(wide, "set_my_photo", { data: b64(PNG) });
  expect(first.photoUrl).toMatch(
    new RegExp(`^/api/photos/${bot.actor.id}/[0-9a-f]{64}$`),
  );
  expect((await call(wide, "whoami")).photoUrl).toBe(first.photoUrl);

  const second = await call(wide, "set_my_photo", { data: b64(OTHER_PNG) });
  expect(second.photoUrl).not.toBe(first.photoUrl);
  expect((await call(wide, "whoami")).photoUrl).toBe(second.photoUrl);

  expect(await call(wide, "clear_my_photo")).toEqual({ photoUrl: null });
  expect((await call(wide, "whoami")).photoUrl).toBeNull();
  expect(await call(wide, "clear_my_photo")).toEqual({ photoUrl: null });
});

test("a bot's photo tools leave another bot's photo as it was", async () => {
  const other = await connect(addBot("other").key);
  const mine = await connect(addBot("mine").key);
  const { photoUrl } = await call(other, "set_my_photo", { data: b64(PNG) });
  await call(mine, "set_my_photo", { data: b64(OTHER_PNG) });
  await call(mine, "clear_my_photo");
  expect((await call(other, "whoami")).photoUrl).toBe(photoUrl);
});

test("a key limited to reading one project still sets and clears its own photo", async () => {
  const scoped = createBot(db, "reader", {
    scope: { projects: [addProject("scoped").key], actions: ["read"] },
  });
  const reader = await connect(scoped.key);
  const { photoUrl } = await call(reader, "set_my_photo", { data: b64(PNG) });
  expect((await call(reader, "whoami")).photoUrl).toBe(photoUrl);
  await call(reader, "clear_my_photo");
});

test("a data: URL prefix is accepted and the bytes decide the type", async () => {
  const { photoUrl } = await call(wide, "set_my_photo", {
    data: `data:image/png;base64,${b64(JPEG)}`,
  });
  const served = await request("GET", photoUrl);
  expect(served.headers.get("content-type")).toBe("image/jpeg");
});

test.each(["image/jpg", "IMAGE/JPG"])(
  "a data:%s;base64, prefix is accepted as JPEG",
  async (type) => {
    const { photoUrl } = await call(wide, "set_my_photo", {
      data: `data:${type};base64,${b64(JPEG)}`,
    });
    const served = await request("GET", photoUrl);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
  },
);

test.each([
  ["a name parameter", "data:image/png;name=avatar.png;base64,"],
  ["a charset parameter", "data:image/png;charset=utf-8;base64,"],
  ["leading whitespace", "\n  data:image/png;base64,"],
])("a data: URL prefix with %s is accepted", async (_, prefix) => {
  const { photoUrl } = await call(wide, "set_my_photo", {
    data: `${prefix}${b64(PNG)}`,
  });
  const served = await request("GET", photoUrl);
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
});

test.each([
  ["wrapped at 76 columns, as GNU base64 writes it", "\n"],
  ["wrapped with CRLF line ends", "\r\n"],
])("base64 %s stores the same bytes", async (_, eol) => {
  const image = pngOfSize(1000);
  const lines = b64(image).match(/.{1,76}/g) ?? [];
  const wrapped = lines.map((line) => `${line}${eol}`).join("");
  const { photoUrl } = await call(wide, "set_my_photo", { data: wrapped });
  const served = await request("GET", photoUrl);
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(image);
});

test("set_my_photo points larger files to the REST route", async () => {
  const { tools } = await wide.listTools();
  const description =
    tools.find((t) => t.name === "set_my_photo")?.description ?? "";
  expect(description).toContain("PUT /api/v1/me/photo");
});

test("list_bots carries each bot's photo URL", async () => {
  const { photoUrl } = await call(wide, "set_my_photo", { data: b64(PNG) });
  const { items } = await call(wide, "list_bots", { limit: 200 });
  expect(items.find((b: Body) => b.id === bot.actor.id)?.photoUrl).toBe(
    photoUrl,
  );
});

test.each([
  ["an SVG", b64(SVG), /^invalid_image: .*PNG, JPEG or WebP/],
  ["a text file", b64(TEXT), /^invalid_image: .*PNG, JPEG or WebP/],
  ["an empty string", "", /^invalid_image: the photo is empty/],
  [
    "256 KB and one byte",
    b64(pngOfSize(262145)),
    /^payload_too_large: .*262144 bytes/,
  ],
  [
    // the stray character would fail the decode; the length is refused before it
    "base64 longer than any 256 KB photo encodes to, before decoding it",
    `${"A".repeat(349528)}*AAA`,
    /^payload_too_large: .*262144 bytes/,
  ],
  [
    "base64 with a stray character",
    `${b64(PNG).slice(0, -4)}*AAA`,
    /^invalid_image: data is not valid base64/,
  ],
  [
    "base64 missing its padding",
    b64(JPEG).replace(/=+$/, ""),
    /^invalid_image: data is not valid base64/,
  ],
  [
    "a data: URL of another type",
    `data:image/svg+xml;base64,${b64(PNG)}`,
    /^invalid_image: data declares image\/svg\+xml/,
  ],
  [
    "a data: URL whose parameters don't end in base64",
    `data:image/png;base64;name=a.png,${b64(PNG)}`,
    /^invalid_image: data declares image\/png;base64;name=a.png/,
  ],
])("%s is refused and the photo kept", async (_, data, message) => {
  const { photoUrl } = await call(wide, "set_my_photo", { data: b64(PNG) });
  expect(await refusal(wide, "set_my_photo", { data })).toMatch(message);
  expect((await call(wide, "whoami")).photoUrl).toBe(photoUrl);
});

test("exactly 256 KB fits through /mcp as base64", async () => {
  const { photoUrl } = await call(wide, "set_my_photo", {
    data: b64(pngOfSize(262144)),
  });
  expect(photoUrl).toMatch(/^\/api\/photos\//);
});
