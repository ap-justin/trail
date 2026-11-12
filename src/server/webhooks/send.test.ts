import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { createServer, globalAgent, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultSendDeps, httpsTransport, sendWebhook } from "./send.js";
import { TEST_TLS_CERT, TEST_TLS_KEY } from "./test-tls.js";

// The real transport against a TLS server on the loopback. The vetted address
// is 127.0.0.1 (the address check lives in address.ts, not here) while the
// URL names bot.example.com, which has no DNS: a connection can reach the
// server only by going to the address it was handed.
type Seen = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
  sni: string | false | null | undefined;
};
const seen: Seen[] = [];
let respond: (res: ServerResponse) => void = (res) => res.end();
let server: Server;
let port = 0;
let trusted: typeof globalAgent.options.ca;

beforeAll(async () => {
  // the transport takes no CA option, so the one self-signed certificate is trusted on the shared agent
  trusted = globalAgent.options.ca;
  globalAgent.options.ca = TEST_TLS_CERT;
  server = createServer(
    { cert: TEST_TLS_CERT, key: TEST_TLS_KEY },
    (req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
          sni: (req.socket as TLSSocket).servername,
        });
        respond(res);
      });
    },
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  globalAgent.options.ca = trusted;
  server.closeAllConnections();
  server.close();
});

const call = (url: string, signal?: AbortSignal) =>
  httpsTransport({
    url: new URL(url),
    address: "127.0.0.1",
    headers: {
      "content-type": "application/json",
      "x-openbot-signature": "sig",
    },
    body: '{"n":"é"}',
    signal,
  });

describe("httpsTransport", () => {
  test("connects to the vetted address and names the host in SNI and Host", async () => {
    seen.length = 0;
    const { status } = await call(
      `https://bot.example.com:${port}/hooks/trail?x=1`,
    );
    expect(status).toBe(200);
    expect(seen).toHaveLength(1);
    const [got] = seen;
    expect(got?.sni).toBe("bot.example.com");
    expect(got?.headers.host).toBe(`bot.example.com:${port}`);
    expect(got).toMatchObject({
      method: "POST",
      url: "/hooks/trail?x=1",
      body: '{"n":"é"}',
    });
    expect(got?.headers).toMatchObject({
      "content-type": "application/json",
      "x-openbot-signature": "sig",
      "user-agent": "trail-webhooks/1",
      // bytes, not characters
      "content-length": "10",
    });
  });

  test("the certificate is checked against the host name, not the address it connected to", async () => {
    seen.length = 0;
    await expect(
      call(`https://other.example.com:${port}/hook`),
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(seen).toHaveLength(0);
  });

  test("a redirect is a status, never followed", async () => {
    seen.length = 0;
    respond = (res) => {
      res.statusCode = 302;
      res.setHeader("location", `https://bot.example.com:${port}/elsewhere`);
      res.end();
    };
    try {
      const { status } = await call(`https://bot.example.com:${port}/old`);
      expect(status).toBe(302);
      expect(seen.map((s) => s.url)).toEqual(["/old"]);
    } finally {
      respond = (res) => res.end();
    }
  });

  test("an aborted signal cuts a request the receiver never answers", async () => {
    seen.length = 0;
    const held: ServerResponse[] = [];
    respond = (res) => {
      held.push(res);
    };
    try {
      const abort = new AbortController();
      const sent = call(`https://bot.example.com:${port}/hang`, abort.signal);
      const settled = expect(sent).rejects.toMatchObject({
        name: "AbortError",
      });
      for (let i = 0; i < 500 && seen.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(seen).toHaveLength(1);
      abort.abort();
      await settled;
    } finally {
      respond = (res) => res.end();
      for (const res of held) res.destroy();
    }
  });
});

describe("sendWebhook over the real transport", () => {
  // sendWebhook refuses a loopback address, so the vetted public address it
  // resolves is swapped for the loopback one just below the check
  const deps = (deadline: () => AbortSignal) => ({
    ...defaultSendDeps,
    resolve: async () => ["93.184.216.34"],
    transport: (c: Parameters<typeof httpsTransport>[0]) =>
      httpsTransport({ ...c, address: "127.0.0.1" }),
    deadline,
  });
  const webhook = (path: string) => ({
    url: `https://bot.example.com:${port}${path}`,
    secret: "whsec_send_0123456789abcdef",
    deliveryId: "d-1",
    body: "{}",
  });

  test("a redirect fails the delivery for good, telling the bot to set the final URL", async () => {
    seen.length = 0;
    respond = (res) => {
      res.statusCode = 301;
      res.setHeader("location", `https://bot.example.com:${port}/new`);
      res.end();
    };
    try {
      const result = await sendWebhook(
        { ...deps(() => AbortSignal.timeout(5_000)), now: () => 0 },
        webhook("/old"),
      );
      expect(result).toMatchObject({
        ok: false,
        status: 301,
        retryable: false,
      });
      expect(result.ok === false && result.error).toContain(
        "does not follow redirects",
      );
      expect(seen).toHaveLength(1);
    } finally {
      respond = (res) => res.end();
    }
  });

  test("the deadline cuts a receiver that never answers, and the failure is retryable", async () => {
    seen.length = 0;
    const held: ServerResponse[] = [];
    respond = (res) => {
      held.push(res);
    };
    try {
      const deadline = new AbortController();
      const sent = sendWebhook(
        deps(() => deadline.signal),
        webhook("/slow"),
      );
      for (let i = 0; i < 500 && seen.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(seen).toHaveLength(1);
      deadline.abort();
      expect(await sent).toEqual({
        ok: false,
        status: null,
        error: "no answer within 10s",
        retryable: true,
      });
    } finally {
      respond = (res) => res.end();
      for (const res of held) res.destroy();
    }
  });
});

test("a shutdown cuts a lookup that hasn't answered, and nothing is sent", async () => {
  let sent = 0;
  const shutdown = new AbortController();
  const result = sendWebhook(
    {
      ...defaultSendDeps,
      resolve: () => new Promise(() => {}),
      transport: async () => {
        sent++;
        return { status: 200 };
      },
    },
    {
      url: "https://bot.example.com/hook",
      secret: "s",
      deliveryId: "d",
      body: "{}",
    },
    shutdown.signal,
  );
  shutdown.abort();
  expect(await result).toMatchObject({ ok: false, retryable: true });
  expect(sent).toBe(0);
});

describe("sendWebhook's status classes", () => {
  const send = (status: number) =>
    sendWebhook(
      {
        ...defaultSendDeps,
        resolve: async () => ["93.184.216.34"],
        transport: async () => ({ status }),
      },
      {
        url: "https://bot.example.com/hook",
        secret: "s",
        deliveryId: "d",
        body: "{}",
      },
    );

  test.each([200, 201, 204, 299])("%i is delivered", async (status) => {
    expect(await send(status)).toEqual({ ok: true, status });
  });

  // 408 and 429 are the receiver asking to be tried again; a 410 is it saying stop
  test.each([
    [400, true],
    [401, true],
    [404, true],
    [408, true],
    [429, true],
    [499, true],
    [410, false],
    [500, true],
    [503, true],
    [301, false],
    [302, false],
    [307, false],
    [399, false],
  ])("%i is retryable: %s", async (status, retryable) => {
    expect(await send(status)).toMatchObject({ ok: false, status, retryable });
  });
});
