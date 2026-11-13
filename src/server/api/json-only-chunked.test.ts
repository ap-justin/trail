import { request as httpRequest, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, expect, test } from "vitest";
import { setupTestApp } from "../test-app.js";

const { app, bot, addProject } = setupTestApp();
const project = addProject("json-only-chunked");

let port = 0;
const listener = serve({ fetch: app.fetch, port: 0 }, (info) => {
  port = info.port;
});
// serve() types an http2 server too, which only a createServer option yields
if (!(listener instanceof Server)) throw new Error("expected an HTTP/1 server");
const server = listener;
beforeAll(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** A POST whose body goes out as two chunks with Transfer-Encoding: chunked and no Content-Length. */
function sendChunked(type: string | undefined, chunks: [string, string]) {
  return new Promise<{
    status: number;
    headers: Record<string, unknown>;
    text: string;
  }>((resolve, reject) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${bot.key}`,
    };
    if (type !== undefined) headers["content-type"] = type;
    const req = httpRequest(
      {
        port,
        host: "127.0.0.1",
        method: "POST",
        path: "/api/v1/webhooks",
        headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          text += d;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text }),
        );
      },
    );
    req.on("error", reject);
    req.write(chunks[0]);
    req.end(chunks[1]);
  });
}

const webhookJson = () =>
  JSON.stringify({
    url: "https://bot.example.com/chunked",
    secret: "whsec_chunked_0123456789abcdef",
    projects: [project.key],
  });

test("a chunked non-JSON body on a write is a 415", async () => {
  const res = await sendChunked("text/plain", [
    "url=https://bot.",
    "example.com",
  ]);
  expect(res.status).toBe(415);
  const { error } = JSON.parse(res.text);
  expect(error.code).toBe("unsupported_media_type");
  expect(error.message).toContain("text/plain");
});

test("a chunked body with no Content-Type is a 415 saying so", async () => {
  const res = await sendChunked(undefined, ["{}", ""]);
  expect(res.status).toBe(415);
  expect(JSON.parse(res.text).error.message).toContain("no Content-Type");
});

test("a chunked JSON body is accepted", async () => {
  const body = webhookJson();
  const res = await sendChunked("application/json", [
    body.slice(0, 20),
    body.slice(20),
  ]);
  expect(res.status).toBe(201);
  expect(JSON.parse(res.text).url).toBe("https://bot.example.com/chunked");
});
